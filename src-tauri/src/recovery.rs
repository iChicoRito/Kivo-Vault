//! Recovery kits: an optional, deliberately confirmed second way to open a
//! vault when its password is forgotten. A kit is a random 32-byte secret that
//! wraps an extra copy of the vault's data key (a "recovery" slot). Kivo never
//! stores the secret; only the exported kit holds it. Recovery replaces the
//! password slot around the same data key, so nothing is deleted or reset.
//! See docs/security/t24-unlock-and-recovery.md.

use std::fs;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

use crate::database::{DatabaseState, PendingRecovery};
use crate::encryption::{self, new_vault_key};
#[cfg(test)]
use crate::key_slots::{KIT_TYPO, MAX_KIT_INPUT};
use crate::key_slots::{self, format_kit, parse_kit, DataKey, VaultScope};
use crate::passwords::{self, VaultKeyState};

const DRAFT_TTL: Duration = Duration::from_secs(5 * 60);

pub(crate) const WRONG_PASSWORD: &str = "That password is not correct";
const WRONG_KIT: &str = "That recovery key does not open this vault";
const DRAFT_GONE: &str = "This recovery kit setup has ended. Start again.";
const NOT_ACTIVE: &str = "That recovery kit is not the active one for this vault";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    pub scope: String,
    /// The vault exists and can have a kit (content needs encryption on).
    pub available: bool,
    /// A confirmed kit is active.
    pub enabled: bool,
}

/// Shown once while setting up. The only time a recovery secret crosses into
/// the app window; it is never stored by Kivo.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDraft {
    pub token: String,
    pub recovery_key: String,
    pub expires_in_seconds: u64,
}

fn parse_scope(scope: &str) -> Result<VaultScope, String> {
    match scope {
        "content" => Ok(VaultScope::Content),
        "passwords" => Ok(VaultScope::Passwords),
        _ => Err("Unknown vault".to_string()),
    }
}

fn available(connection: &Connection, scope: VaultScope) -> Result<bool, String> {
    match scope {
        // Encrypted content, or an app lock on its own (then a kit resets the app-lock password).
        VaultScope::Content => Ok(encryption::is_enabled(connection)?
            || crate::database::has_stored_password_lock(connection)
                .map_err(|error| format!("Could not read app lock: {error}"))?),
        VaultScope::Passwords => passwords::vault_configured(connection)
            .map_err(|error| format!("Could not read the password vault: {error}")),
    }
}

/// Checks the vault's current password and returns its data key. A wrong
/// password is `Err(WRONG_PASSWORD)`.
pub(crate) fn authenticate(connection: &mut Connection, scope: VaultScope, password: &str) -> Result<DataKey, String> {
    match scope {
        VaultScope::Content if encryption::is_enabled(connection)? => {
            encryption::unlock(connection, password)?.ok_or_else(|| WRONG_PASSWORD.to_string())
        }
        VaultScope::Content => authenticate_app_lock(connection, password),
        VaultScope::Passwords => passwords::authenticate_vault_password(connection, password).map_err(|error| {
            if error == "Could not unlock the vault" {
                WRONG_PASSWORD.to_string()
            } else {
                error
            }
        }),
    }
}

/// App lock without encryption has no data key, so a random "lock key" behind
/// the same slots stands in for it. A kit then only lets you set a new app-lock
/// password; nothing is encrypted, so there is nothing else for it to open.
/// Turning encryption on later replaces this identity and its kit.
fn authenticate_app_lock(connection: &Connection, password: &str) -> Result<DataKey, String> {
    let verifier = crate::database::read_password_verifier(connection)
        .map_err(|error| format!("Could not read app lock: {error}"))?
        .ok_or_else(|| "Set a Master Password (App lock) before setting up a recovery kit.".to_string())?;
    if !crate::security::secret_matches(password, &verifier) {
        return Err(WRONG_PASSWORD.to_string());
    }
    if key_slots::has_slots(connection, VaultScope::Content)? {
        if let Ok(Some(key)) = key_slots::unlock_with_password(connection, VaultScope::Content, password) {
            return Ok(key);
        }
    }
    // First kit, or slots out of step with the app-lock password: start fresh.
    let key = new_vault_key()?;
    let tx = connection.unchecked_transaction().map_err(|error| error.to_string())?;
    key_slots::install_password_slot(&tx, VaultScope::Content, &key, password)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(key)
}

/// Counts a wrong password or kit toward the shared wrong-try wait.
fn record<T>(db: &DatabaseState, result: &Result<T, String>) {
    let wrong = matches!(result, Err(error) if error == WRONG_PASSWORD || error == WRONG_KIT);
    if wrong || result.is_ok() {
        db.record_attempt(!wrong);
    }
}

pub(crate) fn read_status_with_state(db: &DatabaseState, scope: &str) -> Result<RecoveryStatus, String> {
    let scope_value = parse_scope(scope)?;
    let guard = db.require_connection()?;
    let connection = guard.as_ref().expect("checked above");
    let available = available(connection, scope_value)?;
    let enabled = available && key_slots::read_slot(connection, scope_value, "recovery")?.is_some();
    Ok(RecoveryStatus {
        scope: scope.to_string(),
        available,
        enabled,
    })
}

/// Step 1: proves the current password and prepares a new kit. Nothing is
/// enabled or replaced until the kit is confirmed; an active kit keeps working.
pub(crate) fn begin_with_state(db: &DatabaseState, scope: &str, password: &str) -> Result<RecoveryDraft, String> {
    let scope_value = parse_scope(scope)?;
    db.check_attempt()?;
    let mut guard = db.require_connection()?;
    let connection = guard.as_mut().expect("checked above");
    let result = (|| {
        let mut key = authenticate(connection, scope_value, password)?;
        let built = (|| {
            let (identity, _) = key_slots::read_identity(connection, scope_value)?
                .ok_or_else(|| "This vault is not ready for a recovery kit".to_string())?;
            let (password_slot_id, _) = key_slots::read_slot(connection, scope_value, "password")?
                .ok_or_else(|| "This vault is not ready for a recovery kit".to_string())?;
            let previous = key_slots::read_slot(connection, scope_value, "recovery")?.map(|(id, _)| id);
            let secret = Zeroizing::new(new_vault_key()?);
            let recovery_id = key_slots::new_hex_id()?;
            let envelope_json = key_slots::wrap_with_secret(&identity, &recovery_id, &key, &secret)?;
            let kit = Zeroizing::new(format_kit(scope_value, &identity.vault_id, &recovery_id, &secret));
            Ok::<_, String>(PendingRecovery {
                token: key_slots::new_hex_id()?,
                scope: scope.to_string(),
                created: Instant::now(),
                kit,
                vault_id: identity.vault_id,
                key_generation: identity.key_generation,
                password_slot_id,
                previous_recovery_id: previous,
                recovery_id,
                envelope_json,
            })
        })();
        key.fill(0);
        built
    })();
    record(db, &result);
    let pending = result?;
    let draft = RecoveryDraft {
        token: pending.token.clone(),
        recovery_key: pending.kit.to_string(),
        expires_in_seconds: DRAFT_TTL.as_secs(),
    };
    *db.pending_recovery()? = Some(pending);
    Ok(draft)
}

fn fresh<'a>(slot: &'a Option<PendingRecovery>, token: &str) -> Result<&'a PendingRecovery, String> {
    slot.as_ref()
        .filter(|pending| pending.token == token && pending.created.elapsed() < DRAFT_TTL)
        .ok_or_else(|| DRAFT_GONE.to_string())
}

fn vault_label(scope: &str) -> &'static str {
    if scope == "content" {
        "Kivo content vault (notes, sources and files)"
    } else {
        "Kivo password vault (saved passwords)"
    }
}

/// The kit file's name and text. The secret never goes in the file name.
pub(crate) fn kit_file(db: &DatabaseState, token: &str) -> Result<(String, Zeroizing<String>), String> {
    let slot = db.pending_recovery()?;
    let pending = fresh(&slot, token)?;
    let name = if pending.scope == "content" {
        "Kivo recovery kit - content vault.txt"
    } else {
        "Kivo recovery kit - password vault.txt"
    };
    let text = Zeroizing::new(format!(
        "KIVO RECOVERY KIT\r\n\r\nVault: {}\r\n\r\nRecovery key:\r\n{}\r\n\r\n\
         Keep this file somewhere safe and separate from your computer and from Kivo backups,\r\n\
         for example printed on paper or on a USB drive in a drawer.\r\n\r\n\
         Anyone who has this key can set a new password for this vault and read what it protects.\r\n\
         It only works for this one vault. If you set up a new kit or turn recovery off,\r\n\
         this key stops working for the live vault, but backups made while it was active\r\n\
         may still open with it.\r\n",
        vault_label(&pending.scope),
        pending.kit.as_str()
    ));
    Ok((name.to_string(), text))
}

/// Step 2: re-entering the key proves it was saved. Only then is the recovery
/// slot written (replacing any older kit), and only if nothing the kit was
/// built against changed meanwhile. Runs under the database lock, so a
/// password change or turning recovery off cannot slip in between.
pub(crate) fn confirm_with_state(db: &DatabaseState, token: &str, recovery_key: &str) -> Result<(), String> {
    let kit = parse_kit(recovery_key)?;
    let guard = db.require_connection()?;
    let connection = guard.as_ref().expect("checked above");
    let mut slot = db.pending_recovery()?;
    let pending = fresh(&slot, token)?;
    let scope = parse_scope(&pending.scope)?;
    if kit.scope != scope || kit.vault_id != pending.vault_id || kit.recovery_id != pending.recovery_id {
        return Err("That is not the recovery key shown above. Check it and try again.".to_string());
    }
    let (identity, check) = key_slots::read_identity(connection, scope)?.ok_or_else(|| DRAFT_GONE.to_string())?;
    let password_slot = key_slots::read_slot(connection, scope, "password")?.map(|(id, _)| id);
    let current_recovery = key_slots::read_slot(connection, scope, "recovery")?.map(|(id, _)| id);
    if identity.vault_id != pending.vault_id
        || identity.key_generation != pending.key_generation
        || password_slot.as_deref() != Some(pending.password_slot_id.as_str())
        || current_recovery != pending.previous_recovery_id
    {
        slot.take();
        return Err(DRAFT_GONE.to_string());
    }
    let Some(mut key) = key_slots::unwrap_with_secret(&identity, &pending.recovery_id, &pending.envelope_json, &kit.secret)? else {
        return Err("That is not the recovery key shown above. Check it and try again.".to_string());
    };
    let valid = key_slots::key_check_matches(&identity, &key, &check);
    key.fill(0);
    if !valid {
        slot.take();
        return Err(DRAFT_GONE.to_string());
    }
    let tx = connection.unchecked_transaction().map_err(|error| error.to_string())?;
    key_slots::put_recovery_slot(&tx, scope, &pending.recovery_id, &pending.envelope_json)?;
    tx.commit().map_err(|error| error.to_string())?;
    slot.take();
    Ok(())
}

pub(crate) fn cancel_with_state(db: &DatabaseState, token: &str) -> Result<(), String> {
    let mut slot = db.pending_recovery()?;
    if slot.as_ref().is_some_and(|pending| pending.token == token) {
        slot.take();
    }
    Ok(())
}

/// Turns recovery off for one vault after checking its current password.
pub(crate) fn disable_with_state(db: &DatabaseState, scope: &str, password: &str) -> Result<(), String> {
    let scope_value = parse_scope(scope)?;
    db.check_attempt()?;
    let mut guard = db.require_connection()?;
    let connection = guard.as_mut().expect("checked above");
    let result = authenticate(connection, scope_value, password).map(|mut key| key.fill(0));
    record(db, &result);
    result?;
    db.clear_pending_recovery();
    let tx = connection.transaction().map_err(|error| error.to_string())?;
    key_slots::remove_recovery_slot(&tx, scope_value)?;
    tx.commit().map_err(|error| error.to_string())
}

/// Uses a kit to set a new password. The same data key stays, so every note,
/// file, saved password and history entry is kept; collection locks stay too.
/// The vault ends locked and opens with the new password. The kit keeps
/// working until it is replaced or turned off.
pub(crate) fn recover_with_state(
    db: &DatabaseState,
    vault: &VaultKeyState,
    scope: &str,
    recovery_key: &str,
    new_password: &str,
) -> Result<(), String> {
    let scope_value = parse_scope(scope)?;
    match scope_value {
        VaultScope::Content if new_password.trim().is_empty() => {
            return Err("Enter a new Master Password".to_string())
        }
        VaultScope::Passwords if new_password.chars().count() < passwords::VAULT_PASSWORD_MIN => {
            return Err("Use at least 8 characters".to_string())
        }
        _ => {}
    }
    db.check_attempt()?;
    let kit = parse_kit(recovery_key)?;
    if kit.scope != scope_value {
        return Err(if scope_value == VaultScope::Content {
            "That is a password vault kit. Use it on the password vault.".to_string()
        } else {
            "That is a content vault kit. Use it on the app unlock screen.".to_string()
        });
    }

    let mut guard = db.require_connection()?;
    let connection = guard.as_mut().expect("checked above");
    let result = (|| {
        let (identity, check) = key_slots::read_identity(connection, scope_value)?
            .filter(|(identity, _)| identity.vault_id == kit.vault_id)
            .ok_or_else(|| WRONG_KIT.to_string())?;
        let (recovery_id, envelope) = key_slots::read_slot(connection, scope_value, "recovery")?
            .ok_or_else(|| NOT_ACTIVE.to_string())?;
        if recovery_id != kit.recovery_id {
            return Err(NOT_ACTIVE.to_string());
        }
        let mut key = key_slots::unwrap_with_secret(&identity, &recovery_id, &envelope, &kit.secret)?
            .ok_or_else(|| WRONG_KIT.to_string())?;
        let outcome = (|| {
            if !key_slots::key_check_matches(&identity, &key, &check) {
                return Err(WRONG_KIT.to_string());
            }
            let tx = connection.transaction().map_err(|error| error.to_string())?;
            if scope_value == VaultScope::Content {
                // The app lock verifier and the password slot change together.
                let verifier = crate::security::hash_secret(new_password)?;
                tx.execute(
                    "UPDATE security SET password_verifier = ?1,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1",
                    params![verifier],
                )
                .map_err(|error| error.to_string())?;
            }
            key_slots::replace_password_slot(&tx, scope_value, &key, new_password)?;
            tx.commit().map_err(|error| error.to_string())
        })();
        key.fill(0);
        outcome
    })();
    record(db, &result);
    result?;

    // Finish locked so the new password is used once to open the vault.
    db.revoke_device_unlock(scope_value.as_str());
    match scope_value {
        VaultScope::Content => {
            let _ = db.content_key().clear();
            db.clear_unlocked_collections();
            db.advance_session();
        }
        VaultScope::Passwords => {
            vault.clear();
            db.clear_pending_recovery();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn read_recovery_status(scope: String, db: State<'_, DatabaseState>) -> Result<RecoveryStatus, String> {
    read_status_with_state(db.inner(), &scope)
}

#[tauri::command]
pub fn begin_recovery_setup(
    scope: String,
    password: String,
    db: State<'_, DatabaseState>,
) -> Result<RecoveryDraft, String> {
    begin_with_state(db.inner(), &scope, &password)
}

/// Saves the kit file through the native save dialog. `false` means the user
/// cancelled; setup stays open either way until it is confirmed.
#[tauri::command]
pub async fn save_recovery_kit(token: String, app: AppHandle) -> Result<bool, String> {
    let (name, text) = {
        let db = tauri::Manager::state::<DatabaseState>(&app);
        kit_file(db.inner(), &token)?
    };
    let picked = app
        .dialog()
        .file()
        .set_file_name(name)
        .add_filter("Text file", &["txt"])
        .blocking_save_file();
    let Some(path) = picked else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|_| "Could not save the recovery kit there".to_string())?;
    fs::write(&path, text.as_bytes()).map_err(|error| format!("Could not save the recovery kit: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub fn confirm_recovery_setup(
    token: String,
    recovery_key: String,
    db: State<'_, DatabaseState>,
) -> Result<(), String> {
    confirm_with_state(db.inner(), &token, &recovery_key)
}

#[tauri::command]
pub fn cancel_recovery_setup(token: String, db: State<'_, DatabaseState>) -> Result<(), String> {
    cancel_with_state(db.inner(), &token)
}

#[tauri::command]
pub fn disable_recovery(scope: String, password: String, db: State<'_, DatabaseState>) -> Result<(), String> {
    disable_with_state(db.inner(), &scope, &password)
}

#[tauri::command]
pub fn recover_vault(
    scope: String,
    recovery_key: String,
    new_password: String,
    db: State<'_, DatabaseState>,
    vault: State<'_, VaultKeyState>,
) -> Result<(), String> {
    recover_with_state(db.inner(), vault.inner(), &scope, &recovery_key, &new_password)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::passwords::CredentialInput;

    const CONTENT_PW: &str = "content master password";
    const VAULT_PW: &str = "credential vault password";

    struct Temp(PathBuf);

    impl Temp {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            Self(std::env::temp_dir().join(format!("kivo-recovery-{label}-{}-{unique}", std::process::id())))
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

    /// Content encryption on, one note, plus a password vault with one credential.
    fn vaults(label: &str) -> (Temp, DatabaseState, VaultKeyState, [u8; 32]) {
        let temp = Temp::new(label);
        let db = temp.state();
        let content_key = {
            let mut guard = db.require_connection().unwrap();
            let connection = guard.as_mut().unwrap();
            connection
                .execute_batch(
                    "INSERT INTO items (id, kind, title, description, content, created_at, updated_at)
                     VALUES ('note', 'note', 'Plan', '', '<p>secret body</p>', 'now', 'now');",
                )
                .unwrap();
            crate::database::write_password_verifier(connection, &crate::security::hash_secret(CONTENT_PW).unwrap()).unwrap();
            encryption::enable(connection, db.files_dir(), CONTENT_PW).unwrap()
        };
        let vault = VaultKeyState::default();
        passwords::setup_vault_with_state(&db, &vault, VAULT_PW).unwrap();
        passwords::save_credential_with_state(
            &db,
            &vault,
            &CredentialInput {
                id: Some("cred".into()).filter(|_| false),
                service: "Bank".into(),
                username: "ada".into(),
                password: "bank-secret".into(),
                url: String::new(),
                category: "Banking".into(),
                tags: Vec::new(),
                notes: String::new(),
                is_favorite: false,
            },
        )
        .unwrap();
        (temp, db, vault, content_key)
    }

    fn enroll(db: &DatabaseState, scope: &str, password: &str) -> String {
        let draft = begin_with_state(db, scope, password).unwrap();
        confirm_with_state(db, &draft.token, &draft.recovery_key).unwrap();
        draft.recovery_key
    }

    fn enabled(db: &DatabaseState, scope: &str) -> bool {
        read_status_with_state(db, scope).unwrap().enabled
    }

    fn content_unlock(db: &DatabaseState, password: &str) -> Option<[u8; 32]> {
        let guard = db.require_connection().unwrap();
        encryption::unlock(guard.as_ref().unwrap(), password).unwrap()
    }

    // ---- Kit format ----

    #[test]
    fn kits_round_trip_and_tolerate_case_spaces_and_the_whole_file() {
        let secret = [7u8; 32];
        let kit = format_kit(VaultScope::Passwords, &"a".repeat(32), &"b".repeat(32), &secret);
        assert!(kit.starts_with("KIVO-RECOVERY-V1:passwords:"));

        for input in [
            kit.clone(),
            format!("   {}  ", kit.to_uppercase()),
            format!("KIVO RECOVERY KIT\nVault: x\n\nRecovery key:\n{kit}\n\nKeep it safe."),
        ] {
            let parsed = parse_kit(&input).unwrap();
            assert_eq!(parsed.scope, VaultScope::Passwords);
            assert_eq!(*parsed.secret, secret);
            assert_eq!(parsed.recovery_id, "b".repeat(32));
        }
    }

    #[test]
    fn typos_unknown_versions_and_oversized_input_are_refused() {
        let kit = format_kit(VaultScope::Content, &"a".repeat(32), &"b".repeat(32), &[1u8; 32]);
        let mut typo = kit.clone();
        let index = typo.len() - 12;
        let replacement = if &typo[index..index + 1] == "0" { "1" } else { "0" };
        typo.replace_range(index..index + 1, replacement);
        assert_eq!(parse_kit(&typo).err().as_deref(), Some(KIT_TYPO));

        for bad in [
            "".to_string(),
            "hello".to_string(),
            kit.replace("V1", "V2"),
            kit.replace(":content:", ":photos:"),
            kit[..kit.len() - 1].to_string(),
            format!("{kit}:extra"),
            "x".repeat(MAX_KIT_INPUT + 1),
        ] {
            assert!(parse_kit(&bad).is_err(), "{bad}");
        }
    }

    // ---- Setup ----

    #[test]
    fn recovery_stays_off_until_the_key_is_entered_back() {
        let (_temp, db, _vault, _key) = vaults("confirm");
        assert!(read_status_with_state(&db, "content").unwrap().available);
        assert!(!enabled(&db, "content"));

        assert_eq!(begin_with_state(&db, "content", "wrong").err().as_deref(), Some(WRONG_PASSWORD));
        let draft = begin_with_state(&db, "content", CONTENT_PW).unwrap();
        assert!(!enabled(&db, "content"), "a shown kit is not active yet");

        let other = format_kit(VaultScope::Content, &"a".repeat(32), &"b".repeat(32), &[9u8; 32]);
        assert!(confirm_with_state(&db, &draft.token, &other).is_err());
        assert!(confirm_with_state(&db, "not-the-token", &draft.recovery_key).is_err());
        assert!(!enabled(&db, "content"));

        confirm_with_state(&db, &draft.token, &draft.recovery_key).unwrap();
        assert!(enabled(&db, "content"));
        assert!(!enabled(&db, "passwords"), "each vault has its own kit");
        assert!(confirm_with_state(&db, &draft.token, &draft.recovery_key).is_err(), "a setup is used once");
    }

    #[test]
    fn a_password_change_or_lock_during_setup_cancels_it() {
        let (_temp, db, _vault, _key) = vaults("stale");
        let draft = begin_with_state(&db, "content", CONTENT_PW).unwrap();
        {
            let mut guard = db.require_connection().unwrap();
            encryption::change_password(guard.as_mut().unwrap(), CONTENT_PW, "changed password").unwrap();
        }
        assert!(confirm_with_state(&db, &draft.token, &draft.recovery_key).is_err());
        assert!(!enabled(&db, "content"));

        let draft = begin_with_state(&db, "passwords", VAULT_PW).unwrap();
        db.advance_session();
        assert!(confirm_with_state(&db, &draft.token, &draft.recovery_key).is_err());
    }

    // ---- Recovery ----

    #[test]
    fn a_content_kit_sets_a_new_password_and_keeps_every_record() {
        let (_temp, db, vault, key) = vaults("recover-content");
        let kit = enroll(&db, "content", CONTENT_PW);
        db.content_key().store(key).unwrap();

        assert!(recover_with_state(&db, &vault, "content", &kit, "  ").is_err());
        recover_with_state(&db, &vault, "content", &kit, "my new password").unwrap();

        assert!(db.content_key().require_key().is_err(), "finishes locked");
        assert_eq!(content_unlock(&db, CONTENT_PW), None, "the forgotten password no longer works");
        let unlocked = content_unlock(&db, "my new password").expect("the new password opens it");
        assert_eq!(unlocked, key, "same data key, nothing re-encrypted or reset");
        let guard = db.require_connection().unwrap();
        let item = encryption::read_secret(guard.as_ref().unwrap(), &unlocked, "note").unwrap();
        assert_eq!(item.content.as_deref(), Some("<p>secret body</p>"));
        drop(guard);
        assert!(enabled(&db, "content"), "the kit stays active");
        assert!(passwords::unlock_vault_with_state(&db, &vault, VAULT_PW).is_ok(), "the other vault is untouched");
    }

    #[test]
    fn a_password_vault_kit_keeps_saved_passwords_and_ends_locked() {
        let (_temp, db, vault, _key) = vaults("recover-passwords");
        let kit = enroll(&db, "passwords", VAULT_PW);
        let id = {
            let guard = db.require_connection().unwrap();
            guard
                .as_ref()
                .unwrap()
                .query_row("SELECT id FROM credentials", [], |row| row.get::<_, String>(0))
                .unwrap()
        };

        assert!(recover_with_state(&db, &vault, "passwords", &kit, "short").is_err());
        recover_with_state(&db, &vault, "passwords", &kit, "brand new vault password").unwrap();

        assert!(vault.require_key().is_err());
        assert!(passwords::unlock_vault_with_state(&db, &vault, VAULT_PW).is_err());
        passwords::unlock_vault_with_state(&db, &vault, "brand new vault password").unwrap();
        assert_eq!(passwords::load_credential_with_state(&db, &vault, &id).unwrap().password, "bank-secret");
        assert_eq!(content_unlock(&db, CONTENT_PW).is_some(), true, "the content vault is untouched");
    }

    #[test]
    fn wrong_mismatched_or_retired_kits_change_nothing() {
        let (_temp, db, vault, _key) = vaults("refuse");
        assert_eq!(
            recover_with_state(&db, &vault, "content", &format_kit(VaultScope::Content, &"a".repeat(32), &"b".repeat(32), &[1; 32]), "new password")
                .err()
                .as_deref(),
            Some(WRONG_KIT),
            "no kit enrolled for this vault"
        );
        let content_kit = enroll(&db, "content", CONTENT_PW);
        let slots_before: String = {
            let guard = db.require_connection().unwrap();
            guard
                .as_ref()
                .unwrap()
                .query_row("SELECT group_concat(envelope_json) FROM vault_key_slots", [], |row| row.get(0))
                .unwrap()
        };

        assert!(recover_with_state(&db, &vault, "passwords", &content_kit, "brand new vault password").is_err(), "a kit only fits its own vault");
        let parsed = parse_kit(&content_kit).unwrap();
        let forged = format_kit(VaultScope::Content, &parsed.vault_id, &parsed.recovery_id, &[3; 32]);
        assert_eq!(recover_with_state(&db, &vault, "content", &forged, "new password").err().as_deref(), Some(WRONG_KIT));
        let slots_after: String = {
            let guard = db.require_connection().unwrap();
            guard
                .as_ref()
                .unwrap()
                .query_row("SELECT group_concat(envelope_json) FROM vault_key_slots", [], |row| row.get(0))
                .unwrap()
        };
        assert_eq!(slots_before, slots_after);
        assert!(content_unlock(&db, CONTENT_PW).is_some());

        // A new kit replaces the old one only once it is confirmed.
        let draft = begin_with_state(&db, "content", CONTENT_PW).unwrap();
        assert!(parse_kit(&content_kit).is_ok());
        confirm_with_state(&db, &draft.token, &draft.recovery_key).unwrap();
        assert_eq!(recover_with_state(&db, &vault, "content", &content_kit, "new password").err().as_deref(), Some(NOT_ACTIVE));

        // Turning recovery off needs the current password and retires the kit.
        assert!(disable_with_state(&db, "content", "wrong").is_err());
        assert!(enabled(&db, "content"));
        disable_with_state(&db, "content", CONTENT_PW).unwrap();
        assert!(!enabled(&db, "content"));
        assert!(recover_with_state(&db, &vault, "content", &draft.recovery_key, "new password").is_err());
    }

    #[test]
    fn a_kit_from_another_vault_does_not_open_this_one() {
        let (_one, first, vault, _key) = vaults("first");
        let (_two, second, _vault2, _key2) = vaults("second");
        enroll(&first, "content", CONTENT_PW);
        let foreign = enroll(&second, "content", CONTENT_PW);

        assert_eq!(recover_with_state(&first, &vault, "content", &foreign, "new password").err().as_deref(), Some(WRONG_KIT));
    }

    #[test]
    fn the_kit_file_holds_the_key_but_its_name_does_not() {
        let (_temp, db, _vault, _key) = vaults("file");
        let draft = begin_with_state(&db, "passwords", VAULT_PW).unwrap();
        let (name, text) = kit_file(&db, &draft.token).unwrap();

        assert!(text.contains(&draft.recovery_key));
        assert!(!name.contains(&draft.recovery_key[17..40]));
        assert!(name.ends_with(".txt"));
        cancel_with_state(&db, &draft.token).unwrap();
        assert!(kit_file(&db, &draft.token).is_err(), "cancel drops the setup");
    }

    // ---- App lock without encryption ----

    /// App lock (Master Password) on, encryption off.
    fn app_lock_only(label: &str) -> (Temp, DatabaseState, VaultKeyState) {
        let temp = Temp::new(label);
        let db = temp.state();
        {
            let mut guard = db.require_connection().unwrap();
            crate::database::write_password_verifier(guard.as_mut().unwrap(), &crate::security::hash_secret(CONTENT_PW).unwrap())
                .unwrap();
        }
        (temp, db, VaultKeyState::default())
    }

    fn app_lock_matches(db: &DatabaseState, password: &str) -> bool {
        let guard = db.require_connection().unwrap();
        let verifier = crate::database::read_password_verifier(guard.as_ref().unwrap()).unwrap().unwrap();
        crate::security::secret_matches(password, &verifier)
    }

    #[test]
    fn an_app_lock_alone_can_have_a_kit_that_sets_a_new_master_password() {
        let (_temp, db, vault) = app_lock_only("applock");
        assert!(read_status_with_state(&db, "content").unwrap().available);
        assert_eq!(begin_with_state(&db, "content", "wrong").err().as_deref(), Some(WRONG_PASSWORD));

        let kit = enroll(&db, "content", CONTENT_PW);
        assert!(enabled(&db, "content"));

        recover_with_state(&db, &vault, "content", &kit, "my new master password").unwrap();
        assert!(app_lock_matches(&db, "my new master password"));
        assert!(!app_lock_matches(&db, CONTENT_PW));
        assert!(enabled(&db, "content"), "the kit keeps working");

        // A normal password change keeps the kit in step.
        {
            let mut guard = db.require_connection().unwrap();
            encryption::change_password(guard.as_mut().unwrap(), "my new master password", "third password").unwrap();
        }
        assert!(enabled(&db, "content"));
        recover_with_state(&db, &vault, "content", &kit, "fourth password").unwrap();
        assert!(app_lock_matches(&db, "fourth password"));
    }

    #[test]
    fn an_app_lock_kit_retires_when_the_lock_is_replaced_removed_or_encryption_starts() {
        let (_temp, db, vault) = app_lock_only("applock-retire");
        enroll(&db, "content", CONTENT_PW);
        {
            let mut guard = db.require_connection().unwrap();
            crate::database::write_password_verifier(guard.as_mut().unwrap(), &crate::security::hash_secret("set again").unwrap())
                .unwrap();
        }
        assert!(!enabled(&db, "content"), "a newly set app-lock password retires the kit");

        let kit = enroll(&db, "content", "set again");
        {
            let mut guard = db.require_connection().unwrap();
            encryption::enable(guard.as_mut().unwrap(), db.files_dir(), "set again").unwrap();
        }
        assert!(!enabled(&db, "content"), "encryption replaces the app-lock kit");
        assert!(recover_with_state(&db, &vault, "content", &kit, "new password").is_err());
        assert!(content_unlock(&db, "set again").is_some(), "the encrypted vault opens normally");

        let (_temp2, other, _vault2) = app_lock_only("applock-remove");
        enroll(&other, "content", CONTENT_PW);
        {
            let mut guard = other.require_connection().unwrap();
            crate::database::clear_password_verifier(guard.as_mut().unwrap()).unwrap();
        }
        assert!(!read_status_with_state(&other, "content").unwrap().available);
    }
}
