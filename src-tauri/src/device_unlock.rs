//! Windows Hello unlock. Rust asks Windows for a fresh verification (face,
//! fingerprint or PIN) for the Kivo window, and only after a `Verified` answer
//! opens a copy of the vault key protected with current-user DPAPI. The copy
//! lives in app data outside the database and is never exported or backed up.
//!
//! Limit (accepted in phase 1): DPAPI ties the copy to the Windows account,
//! not to Windows Hello. Another program running as the same user could open
//! it without a prompt. Kivo's check stops copied app data and accidental
//! bypass in the app, not malware already running as you.

use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::database::DatabaseState;
use crate::encryption;
use crate::key_slots::{self, DataKey, VaultScope};
use crate::passwords::VaultKeyState;

const PAYLOAD_VERSION: u32 = 1;
const MAX_FILE: u64 = 16 * 1024;
const PROMPT: &str = "Unlock Kivo";

pub(crate) enum Verification {
    Verified,
    Canceled,
    Failed(String),
}

/// The operating system side, swappable in tests.
pub(crate) trait DeviceProvider: Send + Sync {
    /// `Err` carries a plain reason the user can act on.
    fn available(&self) -> Result<(), String>;
    fn verify(&self, hwnd: isize, message: &str) -> Result<Verification, String>;
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String>;
    fn unprotect(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUnlockStatus {
    pub scope: String,
    pub available: bool,
    pub enrolled: bool,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUnlockResult {
    /// `unlocked` or `cancelled`.
    pub status: String,
}

/// What DPAPI protects. Bound to this installation and to the vault identity.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payload {
    version: u32,
    scope: String,
    vault_id: String,
    key_generation: String,
    installation_id: String,
    key: String,
}

/// What sits on disk: only DPAPI ciphertext.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnrollmentFile {
    version: u32,
    scope: String,
    protected: String,
}

fn parse_scope(scope: &str) -> Result<VaultScope, String> {
    match scope {
        "content" => Ok(VaultScope::Content),
        "passwords" => Ok(VaultScope::Passwords),
        _ => Err("Unknown vault".to_string()),
    }
}

fn enrollment_path(db: &DatabaseState, scope: VaultScope) -> PathBuf {
    db.device_dir().join(format!("{}.json", scope.as_str()))
}

/// A random id for this installation, made on first enrollment. A copied app
/// data folder on another computer has the file but not the matching DPAPI key.
fn installation_id(db: &DatabaseState, create: bool) -> Result<Option<String>, String> {
    let path = db.device_dir().join("installation-id");
    if let Ok(id) = fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(Some(id));
        }
    }
    if !create {
        return Ok(None);
    }
    fs::create_dir_all(db.device_dir()).map_err(|error| format!("Could not save Windows Hello setup: {error}"))?;
    let id = key_slots::new_hex_id()?;
    fs::write(&path, &id).map_err(|error| format!("Could not save Windows Hello setup: {error}"))?;
    Ok(Some(id))
}

/// Which vault states can use Windows Hello: an encrypted content vault, an
/// app lock without encryption (its lock key), or a set-up password vault.
fn eligible(connection: &Connection, scope: VaultScope) -> Result<Result<(), String>, String> {
    Ok(match scope {
        VaultScope::Content => {
            let lock = crate::database::has_stored_password_lock(connection).map_err(|error| error.to_string())?;
            if encryption::is_enabled(connection)? || lock {
                Ok(())
            } else {
                Err("Set a Master Password in App lock first.".to_string())
            }
        }
        VaultScope::Passwords => {
            if crate::passwords::vault_configured(connection).map_err(|error| error.to_string())? {
                Ok(())
            } else {
                Err("Create the password vault first.".to_string())
            }
        }
    })
}

/// The lock generation a pending enrollment or unlock must still see.
fn generation(db: &DatabaseState, vault: &VaultKeyState, scope: VaultScope) -> u64 {
    match scope {
        VaultScope::Content => db.session_generation(),
        VaultScope::Passwords => vault.generation(),
    }
}

pub(crate) fn status_with(
    db: &DatabaseState,
    provider: &dyn DeviceProvider,
    scope: &str,
) -> Result<DeviceUnlockStatus, String> {
    let scope_value = parse_scope(scope)?;
    let eligible = {
        let guard = db.require_connection()?;
        eligible(guard.as_ref().expect("checked above"), scope_value)?
    };
    let reason = eligible.err().or_else(|| provider.available().err());
    Ok(DeviceUnlockStatus {
        scope: scope.to_string(),
        available: reason.is_none(),
        enrolled: enrollment_path(db, scope_value).is_file(),
        unavailable_reason: reason,
    })
}

/// Sets up Windows Hello for one vault: checks its password, asks Windows for
/// a fresh verification, then saves a DPAPI-protected copy of the vault key.
/// Nothing is saved if the prompt is cancelled or the vault locked meanwhile.
pub(crate) fn enroll_with(
    db: &DatabaseState,
    vault: &VaultKeyState,
    provider: &dyn DeviceProvider,
    scope: &str,
    password: &str,
    hwnd: isize,
) -> Result<DeviceUnlockResult, String> {
    let scope_value = parse_scope(scope)?;
    db.check_attempt()?;
    let (key, generation_before) = {
        let mut guard = db.require_connection()?;
        let connection = guard.as_mut().expect("checked above");
        if let Err(reason) = eligible(connection, scope_value)? {
            return Err(reason);
        }
        let generation_before = generation(db, vault, scope_value);
        let result = crate::recovery::authenticate(connection, scope_value, password);
        let wrong = matches!(&result, Err(error) if error == crate::recovery::WRONG_PASSWORD);
        if wrong || result.is_ok() {
            db.record_attempt(!wrong);
        }
        (Zeroizing::new(result?), generation_before)
    };
    provider.available()?;

    // The prompt runs without the database lock.
    match provider.verify(hwnd, PROMPT)? {
        Verification::Verified => {}
        Verification::Canceled => return Ok(DeviceUnlockResult { status: "cancelled".into() }),
        Verification::Failed(reason) => return Err(reason),
    }

    let installation = installation_id(db, true)?.expect("created above");
    let guard = db.require_connection()?;
    let connection = guard.as_ref().expect("checked above");
    let (identity, check) = key_slots::read_identity(connection, scope_value)?
        .ok_or_else(|| "This vault is not ready for Windows Hello".to_string())?;
    // A lock, password change, restore or turn-off during the prompt wins.
    if generation(db, vault, scope_value) != generation_before || !key_slots::key_check_matches(&identity, &key, &check) {
        return Err("Kivo locked or changed while Windows Hello was open. Try again.".to_string());
    }
    let payload = Zeroizing::new(
        serde_json::to_vec(&Payload {
            version: PAYLOAD_VERSION,
            scope: scope.to_string(),
            vault_id: identity.vault_id,
            key_generation: identity.key_generation,
            installation_id: installation,
            key: STANDARD.encode(*key),
        })
        .map_err(|_| "Could not protect the vault key".to_string())?,
    );
    let protected = provider.protect(&payload)?;
    let file = serde_json::to_vec(&EnrollmentFile {
        version: PAYLOAD_VERSION,
        scope: scope.to_string(),
        protected: STANDARD.encode(protected),
    })
    .map_err(|_| "Could not save Windows Hello setup".to_string())?;
    let path = enrollment_path(db, scope_value);
    let partial = path.with_extension("partial");
    fs::create_dir_all(db.device_dir()).map_err(|error| format!("Could not save Windows Hello setup: {error}"))?;
    fs::write(&partial, file).map_err(|error| format!("Could not save Windows Hello setup: {error}"))?;
    fs::rename(&partial, &path).map_err(|error| {
        let _ = fs::remove_file(&partial);
        format!("Could not save Windows Hello setup: {error}")
    })?;
    Ok(DeviceUnlockResult { status: "enrolled".into() })
}

fn read_enrollment(path: &Path, scope: &str) -> Result<Vec<u8>, String> {
    let gone = || "Windows Hello is not set up for this vault.".to_string();
    let metadata = fs::metadata(path).map_err(|_| gone())?;
    if !metadata.is_file() || metadata.len() > MAX_FILE {
        return Err(gone());
    }
    let file: EnrollmentFile = serde_json::from_slice(&fs::read(path).map_err(|_| gone())?).map_err(|_| gone())?;
    if file.version != PAYLOAD_VERSION || file.scope != scope {
        return Err(gone());
    }
    STANDARD.decode(file.protected).map_err(|_| gone())
}

/// Setup files with a Windows Hello prompt open, so a second click waits its turn.
static PROMPTING: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Unlocks one vault with Windows Hello. The key is opened only after a
/// `Verified` answer, must match this installation and the vault's current
/// identity and key check, and is installed only if no lock happened during
/// the prompt. A damaged or stale setup is removed; the password still works.
pub(crate) fn unlock_with(
    db: &DatabaseState,
    vault: &VaultKeyState,
    provider: &dyn DeviceProvider,
    scope: &str,
    hwnd: isize,
) -> Result<DeviceUnlockResult, String> {
    let scope_value = parse_scope(scope)?;
    let path = enrollment_path(db, scope_value);
    {
        let mut open = PROMPTING.lock().map_err(|_| "Windows Hello is busy".to_string())?;
        if !open.get_or_insert_with(HashSet::new).insert(path.clone()) {
            return Err("Windows Hello is already open.".to_string());
        }
    }
    let result = (|| {
        let sealed = read_enrollment(&path, scope)?;
        provider.available()?;
        let generation_before = generation(db, vault, scope_value);
        match provider.verify(hwnd, PROMPT)? {
            Verification::Verified => {}
            Verification::Canceled => return Ok(DeviceUnlockResult { status: "cancelled".into() }),
            Verification::Failed(reason) => return Err(reason),
        }
        let stale = |db: &DatabaseState| {
            db.revoke_device_unlock(scope_value.as_str());
            "Windows Hello setup is out of date. Unlock with your password and set it up again.".to_string()
        };
        let Ok(plain) = provider.unprotect(&sealed) else {
            return Err(stale(db));
        };
        let Ok(payload) = serde_json::from_slice::<Payload>(&plain) else {
            return Err(stale(db));
        };
        let key: Zeroizing<DataKey> = match STANDARD.decode(&payload.key).ok().and_then(|bytes| bytes.try_into().ok()) {
            Some(key) => Zeroizing::new(key),
            None => return Err(stale(db)),
        };
        if payload.version != PAYLOAD_VERSION
            || payload.scope != scope
            || installation_id(db, false)?.as_deref() != Some(payload.installation_id.as_str())
        {
            return Err(stale(db));
        }

        let guard = db.require_connection()?;
        let connection = guard.as_ref().expect("checked above");
        let identity = key_slots::read_identity(connection, scope_value)?;
        let current = identity.as_ref().is_some_and(|(identity, check)| {
            identity.vault_id == payload.vault_id
                && identity.key_generation == payload.key_generation
                && key_slots::key_check_matches(identity, &key, check)
        });
        if !current {
            drop(guard);
            return Err(stale(db));
        }
        if generation(db, vault, scope_value) != generation_before {
            return Err("Kivo locked while Windows Hello was open. Try again.".to_string());
        }
        match scope_value {
            VaultScope::Content => {
                // With encryption on the key opens content; with app lock alone
                // the verified lock key is the proof and nothing is installed.
                if encryption::is_enabled(connection)? {
                    encryption::seal_all(connection, &key)?;
                    db.content_key().store(*key)?;
                }
            }
            VaultScope::Passwords => vault.store_if_current(*key, generation_before)?,
        }
        Ok(DeviceUnlockResult { status: "unlocked".into() })
    })();
    if let Ok(mut open) = PROMPTING.lock() {
        open.get_or_insert_with(HashSet::new).remove(&path);
    }
    result
}

/// Turns Windows Hello off for one vault after checking its password.
pub(crate) fn disable_with(db: &DatabaseState, scope: &str, password: &str) -> Result<(), String> {
    let scope_value = parse_scope(scope)?;
    db.check_attempt()?;
    let mut guard = db.require_connection()?;
    let connection = guard.as_mut().expect("checked above");
    let result = crate::recovery::authenticate(connection, scope_value, password).map(|mut key| key.fill(0));
    let wrong = matches!(&result, Err(error) if error == crate::recovery::WRONG_PASSWORD);
    if wrong || result.is_ok() {
        db.record_attempt(!wrong);
    }
    result?;
    db.revoke_device_unlock(scope_value.as_str());
    Ok(())
}

#[cfg(windows)]
mod platform {
    use windows::core::{factory, w, HSTRING};
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::{LocalFree, HLOCAL, HWND};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    use windows::Win32::System::WinRT::{IUserConsentVerifierInterop, RoInitialize, RO_INIT_MULTITHREADED};
    use windows_future::IAsyncOperation;
    use zeroize::Zeroizing;

    use super::{DeviceProvider, Verification};

    pub struct WindowsHello;

    fn init() {
        // Already initialized (or in another mode) is fine for these calls.
        let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    }

    fn reason(code: i32) -> String {
        match code {
            1 => "No Windows Hello device or PIN is set up on this computer.".into(),
            2 => "Set up Windows Hello (face, fingerprint or PIN) in Windows Settings first.".into(),
            3 => "Windows Hello is turned off by your organization.".into(),
            4 => "Windows Hello is busy. Try again in a moment.".into(),
            5 => "Too many tries. Unlock with your password.".into(),
            _ => "Windows Hello is not available.".into(),
        }
    }

    /// Copies and frees a DPAPI output buffer, wiping it first.
    fn take(blob: CRYPT_INTEGER_BLOB) -> Zeroizing<Vec<u8>> {
        let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
        unsafe {
            std::ptr::write_bytes(blob.pbData, 0, blob.cbData as usize);
            let _ = LocalFree(Some(HLOCAL(blob.pbData.cast())));
        }
        Zeroizing::new(bytes)
    }

    impl DeviceProvider for WindowsHello {
        fn available(&self) -> Result<(), String> {
            init();
            let availability = UserConsentVerifier::CheckAvailabilityAsync()
                .and_then(|operation| operation.get())
                .map_err(|_| "Windows Hello could not be checked on this computer.".to_string())?;
            if availability == UserConsentVerifierAvailability::Available {
                Ok(())
            } else {
                Err(reason(availability.0))
            }
        }

        fn verify(&self, hwnd: isize, message: &str) -> Result<Verification, String> {
            init();
            let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
                .map_err(|_| "Windows Hello needs Windows 11 (build 22000) or later.".to_string())?;
            let operation: IAsyncOperation<UserConsentVerificationResult> = unsafe {
                interop.RequestVerificationForWindowAsync(HWND(hwnd as *mut core::ffi::c_void), &HSTRING::from(message))
            }
            .map_err(|_| "Windows Hello could not start.".to_string())?;
            let result = operation.get().map_err(|_| "Windows Hello did not answer.".to_string())?;
            Ok(match result {
                UserConsentVerificationResult::Verified => Verification::Verified,
                UserConsentVerificationResult::Canceled => Verification::Canceled,
                other => Verification::Failed(reason(other.0)),
            })
        }

        fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
            let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
            let mut output = CRYPT_INTEGER_BLOB::default();
            // Current user only: no machine-wide flag, no prompt structure.
            unsafe { CryptProtectData(&input, w!("Kivo vault key"), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
                .map_err(|_| "Could not protect the vault key on this computer.".to_string())?;
            Ok(take(output).to_vec())
        }

        fn unprotect(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            let input = CRYPT_INTEGER_BLOB { cbData: sealed.len() as u32, pbData: sealed.as_ptr() as *mut u8 };
            let mut output = CRYPT_INTEGER_BLOB::default();
            unsafe { CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
                .map_err(|_| "The saved Windows Hello key could not be opened.".to_string())?;
            Ok(take(output))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn dpapi_round_trips_for_the_current_user_and_rejects_damage() {
            let sealed = WindowsHello.protect(b"vault key bytes").unwrap();
            assert!(!sealed.windows(15).any(|part| part == b"vault key bytes"));
            assert_eq!(WindowsHello.unprotect(&sealed).unwrap().as_slice(), b"vault key bytes");
            let mut damaged = sealed.clone();
            let middle = damaged.len() / 2;
            damaged[middle] ^= 1;
            assert!(WindowsHello.unprotect(&damaged).is_err());
        }
    }
}

/// Every other platform: no device unlock, never a password-free fallback.
#[cfg(not(windows))]
mod platform {
    use zeroize::Zeroizing;

    use super::{DeviceProvider, Verification};

    pub struct WindowsHello;

    impl DeviceProvider for WindowsHello {
        fn available(&self) -> Result<(), String> {
            Err("Windows Hello unlock is only available on Windows.".into())
        }
        fn verify(&self, _hwnd: isize, _message: &str) -> Result<Verification, String> {
            Err("Windows Hello unlock is only available on Windows.".into())
        }
        fn protect(&self, _plain: &[u8]) -> Result<Vec<u8>, String> {
            Err("Windows Hello unlock is only available on Windows.".into())
        }
        fn unprotect(&self, _sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            Err("Windows Hello unlock is only available on Windows.".into())
        }
    }
}

use platform::WindowsHello;

fn window_handle(window: &tauri::Window) -> Result<isize, String> {
    #[cfg(windows)]
    {
        window
            .hwnd()
            .map(|hwnd| hwnd.0 as isize)
            .map_err(|_| "Could not find the Kivo window.".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("Windows Hello unlock is only available on Windows.".into())
    }
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| "Windows Hello did not finish.".to_string())?
}

#[tauri::command]
pub async fn read_device_unlock_status(scope: String, app: AppHandle) -> Result<DeviceUnlockStatus, String> {
    blocking(move || status_with(app.state::<DatabaseState>().inner(), &WindowsHello, &scope)).await
}

#[tauri::command]
pub async fn enroll_device_unlock(
    scope: String,
    password: String,
    window: tauri::Window,
    app: AppHandle,
) -> Result<DeviceUnlockResult, String> {
    let hwnd = window_handle(&window)?;
    blocking(move || {
        enroll_with(
            app.state::<DatabaseState>().inner(),
            app.state::<VaultKeyState>().inner(),
            &WindowsHello,
            &scope,
            &password,
            hwnd,
        )
    })
    .await
}

#[tauri::command]
pub async fn unlock_with_device(scope: String, window: tauri::Window, app: AppHandle) -> Result<DeviceUnlockResult, String> {
    let hwnd = window_handle(&window)?;
    blocking(move || {
        unlock_with(
            app.state::<DatabaseState>().inner(),
            app.state::<VaultKeyState>().inner(),
            &WindowsHello,
            &scope,
            hwnd,
        )
    })
    .await
}

#[tauri::command(async)]
pub fn disable_device_unlock(scope: String, password: String, db: State<'_, DatabaseState>) -> Result<(), String> {
    disable_with(db.inner(), &scope, &password)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    const CONTENT_PW: &str = "content master password";
    const VAULT_PW: &str = "credential vault password";

    /// Stands in for Windows: a scripted prompt answer and a reversible "DPAPI".
    struct Fake {
        available: Result<(), String>,
        answer: Box<dyn Fn() -> Verification + Send + Sync>,
    }

    impl Fake {
        fn verified() -> Self {
            Self { available: Ok(()), answer: Box::new(|| Verification::Verified) }
        }
        fn answering(answer: impl Fn() -> Verification + Send + Sync + 'static) -> Self {
            Self { available: Ok(()), answer: Box::new(answer) }
        }
    }

    impl DeviceProvider for Fake {
        fn available(&self) -> Result<(), String> {
            self.available.clone()
        }
        fn verify(&self, _hwnd: isize, _message: &str) -> Result<Verification, String> {
            Ok((self.answer)())
        }
        fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
            Ok(std::iter::once(0xAA).chain(plain.iter().map(|byte| byte ^ 0x5A)).collect())
        }
        fn unprotect(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            match sealed.split_first() {
                Some((0xAA, rest)) => Ok(Zeroizing::new(rest.iter().map(|byte| byte ^ 0x5A).collect())),
                _ => Err("damaged".into()),
            }
        }
    }

    struct Temp(PathBuf);

    impl Temp {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            Self(std::env::temp_dir().join(format!("kivo-device-{label}-{}-{unique}", std::process::id())))
        }
        fn state(&self) -> DatabaseState {
            let state = DatabaseState::new(self.0.join("kivo.db"), self.0.join("files"));
            state.initialize().unwrap();
            state
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Encrypted content (or app lock only) plus a password vault.
    fn vaults(label: &str, encrypted: bool) -> (Temp, DatabaseState, VaultKeyState, Option<[u8; 32]>) {
        let temp = Temp::new(label);
        let db = temp.state();
        let key = {
            let mut guard = db.require_connection().unwrap();
            let connection = guard.as_mut().unwrap();
            crate::database::write_password_verifier(connection, &crate::security::hash_secret(CONTENT_PW).unwrap()).unwrap();
            encrypted.then(|| encryption::enable(connection, &db.files_dir(), CONTENT_PW).unwrap())
        };
        let vault = VaultKeyState::default();
        crate::passwords::setup_vault_with_state(&db, &vault, VAULT_PW).unwrap();
        vault.clear();
        (temp, db, vault, key)
    }

    fn enrolled(db: &DatabaseState, scope: &str) -> bool {
        status_with(db, &Fake::verified(), scope).unwrap().enrolled
    }

    #[test]
    fn status_explains_what_is_missing() {
        let temp = Temp::new("status");
        let db = temp.state();
        let status = status_with(&db, &Fake::verified(), "content").unwrap();
        assert!(!status.available);
        assert_eq!(status.unavailable_reason.as_deref(), Some("Set a Master Password in App lock first."));
        assert_eq!(
            status_with(&db, &Fake::verified(), "passwords").unwrap().unavailable_reason.as_deref(),
            Some("Create the password vault first.")
        );

        let (_temp, db, _vault, _key) = vaults("status-ready", true);
        let unavailable = Fake { available: Err("Set up Windows Hello first.".into()), answer: Box::new(|| Verification::Verified) };
        assert_eq!(status_with(&db, &unavailable, "content").unwrap().unavailable_reason.as_deref(), Some("Set up Windows Hello first."));
        let ready = status_with(&db, &Fake::verified(), "content").unwrap();
        assert!(ready.available && !ready.enrolled);
    }

    #[test]
    fn enrollment_needs_the_password_and_a_verified_prompt() {
        let (_temp, db, vault, key) = vaults("enroll", true);
        assert!(enroll_with(&db, &vault, &Fake::verified(), "content", "wrong", 0).is_err());
        assert_eq!(enroll_with(&db, &vault, &Fake::answering(|| Verification::Canceled), "content", CONTENT_PW, 0).unwrap().status, "cancelled");
        assert!(enroll_with(&db, &vault, &Fake::answering(|| Verification::Failed("Too many tries".into())), "content", CONTENT_PW, 0).is_err());
        assert!(!enrolled(&db, "content"));

        enroll_with(&db, &vault, &Fake::verified(), "content", CONTENT_PW, 0).unwrap();
        assert!(enrolled(&db, "content"));
        assert!(!enrolled(&db, "passwords"), "each vault is set up on its own");
        let file = fs::read_to_string(enrollment_path(&db, VaultScope::Content)).unwrap();
        assert!(!file.contains(&STANDARD.encode(key.unwrap())), "no readable key on disk");
    }

    #[test]
    fn t25_windows_hello_and_recovery_kits_stay_with_their_own_vault() {
        let (_first_temp, db, vault, _key) = vaults("t25-first", true);
        let (second_temp, second_db, _second_vault, _second_key) = vaults("t25-second", true);
        drop(second_db);
        enroll_with(&db, &vault, &Fake::verified(), "content", CONTENT_PW, 0).unwrap();
        let draft = crate::recovery::begin_with_state(&db, "content", CONTENT_PW).unwrap();
        crate::recovery::confirm_with_state(&db, &draft.token, &draft.recovery_key).unwrap();
        let first_enrollment = fs::read(enrollment_path(&db, VaultScope::Content)).unwrap();

        // Switch the one app state to the other vault, as the vault switcher does.
        db.open_root(&second_temp.0).unwrap();

        assert!(!enrolled(&db, "content"), "Windows Hello is set up per vault");
        assert!(unlock_with(&db, &vault, &Fake::verified(), "content", 0).is_err());
        // Even a copied enrollment file does not open the other vault.
        fs::create_dir_all(db.device_dir()).unwrap();
        fs::write(enrollment_path(&db, VaultScope::Content), &first_enrollment).unwrap();
        assert!(unlock_with(&db, &vault, &Fake::verified(), "content", 0).is_err());
        assert!(db.content_key().require_key().is_err());

        // The first vault's recovery kit cannot reset the second vault's password.
        assert!(crate::recovery::recover_with_state(&db, &vault, "content", &draft.recovery_key, "taken over").is_err());
        let mut guard = db.require_connection().unwrap();
        assert!(crate::recovery::authenticate(guard.as_mut().unwrap(), VaultScope::Content, CONTENT_PW).is_ok());
    }

    #[test]
    fn a_verified_prompt_unlocks_each_vault_and_cancel_keeps_it_locked() {
        let (_temp, db, vault, key) = vaults("unlock", true);
        enroll_with(&db, &vault, &Fake::verified(), "content", CONTENT_PW, 0).unwrap();
        enroll_with(&db, &vault, &Fake::verified(), "passwords", VAULT_PW, 0).unwrap();
        db.content_key().clear().unwrap();

        assert_eq!(unlock_with(&db, &vault, &Fake::answering(|| Verification::Canceled), "content", 0).unwrap().status, "cancelled");
        assert!(db.content_key().require_key().is_err());
        assert!(unlock_with(&db, &vault, &Fake::answering(|| Verification::Failed("No".into())), "content", 0).is_err());
        assert!(db.content_key().require_key().is_err());

        assert_eq!(unlock_with(&db, &vault, &Fake::verified(), "content", 0).unwrap().status, "unlocked");
        assert_eq!(db.content_key().require_key().unwrap(), key.unwrap());
        assert!(vault.require_key().is_err(), "unlocking content never unlocks the password vault");

        unlock_with(&db, &vault, &Fake::verified(), "passwords", 0).unwrap();
        assert!(vault.require_key().is_ok());
        assert!(enrolled(&db, "content"), "normal locks keep the setup");
    }

    #[test]
    fn a_lock_during_the_prompt_wins() {
        let (_temp, db, vault, _key) = vaults("race", true);
        let db = std::sync::Arc::new(db);
        let racing = db.clone();
        let locker = Fake::answering(move || {
            racing.advance_session();
            Verification::Verified
        });
        assert!(enroll_with(&db, &vault, &locker, "content", CONTENT_PW, 0).is_err());
        assert!(!enrolled(&db, "content"));

        enroll_with(&db, &vault, &Fake::verified(), "content", CONTENT_PW, 0).unwrap();
        db.content_key().clear().unwrap();
        assert!(unlock_with(&db, &vault, &locker, "content", 0).is_err());
        assert!(db.content_key().require_key().is_err(), "no key comes back after the lock");
    }

    #[test]
    fn stale_damaged_or_foreign_setups_are_refused_and_removed() {
        let (_temp, db, vault, _key) = vaults("stale", true);
        enroll_with(&db, &vault, &Fake::verified(), "passwords", VAULT_PW, 0).unwrap();

        // Damaged ciphertext.
        let path = enrollment_path(&db, VaultScope::Passwords);
        let mut file: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        file["protected"] = STANDARD.encode(b"not protected").into();
        fs::write(&path, file.to_string()).unwrap();
        assert!(unlock_with(&db, &vault, &Fake::verified(), "passwords", 0).is_err());
        assert!(!enrolled(&db, "passwords"));

        // Another installation (a copied app data folder).
        enroll_with(&db, &vault, &Fake::verified(), "passwords", VAULT_PW, 0).unwrap();
        fs::write(db.device_dir().join("installation-id"), "f".repeat(32)).unwrap();
        assert!(unlock_with(&db, &vault, &Fake::verified(), "passwords", 0).is_err());
        assert!(!enrolled(&db, "passwords"));
        assert!(vault.require_key().is_err());

        // A vault whose key identity changed (for example a restore).
        enroll_with(&db, &vault, &Fake::verified(), "content", CONTENT_PW, 0).unwrap();
        {
            let guard = db.require_connection().unwrap();
            guard.as_ref().unwrap().execute("UPDATE vault_keys SET key_generation = ?1 WHERE scope = 'content'", [ "e".repeat(32) ]).unwrap();
        }
        db.content_key().clear().unwrap();
        assert!(unlock_with(&db, &vault, &Fake::verified(), "content", 0).is_err());
        assert!(db.content_key().require_key().is_err());
        assert!(!enrolled(&db, "content"));
    }

    #[test]
    fn password_changes_recovery_and_reset_remove_the_setup() {
        let (_temp, db, vault, _key) = vaults("revoke", true);
        enroll_with(&db, &vault, &Fake::verified(), "content", CONTENT_PW, 0).unwrap();
        enroll_with(&db, &vault, &Fake::verified(), "passwords", VAULT_PW, 0).unwrap();

        let draft = crate::recovery::begin_with_state(&db, "passwords", VAULT_PW).unwrap();
        crate::recovery::confirm_with_state(&db, &draft.token, &draft.recovery_key).unwrap();
        crate::recovery::recover_with_state(&db, &vault, "passwords", &draft.recovery_key, "a brand new vault password").unwrap();
        assert!(!enrolled(&db, "passwords"), "recovery removes it");
        assert!(enrolled(&db, "content"), "the other vault keeps its own");

        db.revoke_device_unlock("content");
        assert!(!enrolled(&db, "content"));

        enroll_with(&db, &vault, &Fake::verified(), "content", CONTENT_PW, 0).unwrap();
        db.reset().unwrap();
        assert!(!db.device_dir().exists(), "reset removes every setup and the installation id");
    }

    #[test]
    fn turning_it_off_needs_the_password() {
        let (_temp, db, vault, _key) = vaults("disable", true);
        enroll_with(&db, &vault, &Fake::verified(), "content", CONTENT_PW, 0).unwrap();
        assert!(disable_with(&db, "content", "wrong").is_err());
        assert!(enrolled(&db, "content"));
        disable_with(&db, "content", CONTENT_PW).unwrap();
        assert!(!enrolled(&db, "content"));
    }

    #[test]
    fn app_lock_alone_unlocks_through_its_lock_key() {
        let (_temp, db, vault, _key) = vaults("applock", false);
        enroll_with(&db, &vault, &Fake::verified(), "content", CONTENT_PW, 0).unwrap();

        assert_eq!(unlock_with(&db, &vault, &Fake::verified(), "content", 0).unwrap().status, "unlocked");
        assert!(db.content_key().require_key().is_err(), "nothing to install without encryption");

        // A new app-lock password retires the setup.
        {
            let mut guard = db.require_connection().unwrap();
            crate::database::write_password_verifier(guard.as_mut().unwrap(), &crate::security::hash_secret("new lock").unwrap()).unwrap();
        }
        assert!(unlock_with(&db, &vault, &Fake::verified(), "content", 0).is_err());
    }
}
