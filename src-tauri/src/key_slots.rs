//! Versioned wrappers ("slots") around a vault's random data key. Each vault
//! (content, passwords) has its own identity and data key; a slot is one way to
//! unlock it. Every wrapper is bound to its vault, key generation, method and
//! slot id through AES-GCM associated data, so a slot copied to another vault or
//! method does not open. See docs/security/t24-unlock-and-recovery.md.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::encryption::{decrypt_bytes, encrypt_bytes, new_vault_key};

pub type DataKey = [u8; 32];

const ENVELOPE_VERSION: u32 = 1;
const MAX_ENVELOPE_JSON: usize = 4096;
const SALT_LEN: usize = 16;
const KEY_CHECK_PLAINTEXT: &[u8] = b"kivo-vault-key-check-v1";

/// The approved Argon2id profile for v1 password slots.
const KDF_MEMORY_KIB: u32 = 64 * 1024;
const KDF_ITERATIONS: u32 = 3;
const KDF_PARALLELISM: u32 = 1;

const DAMAGED: &str = "The saved unlock data for this vault is damaged";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultScope {
    Content,
    Passwords,
}

impl VaultScope {
    pub fn as_str(self) -> &'static str {
        match self {
            VaultScope::Content => "content",
            VaultScope::Passwords => "passwords",
        }
    }
}

/// Who a key belongs to. `key_generation` changes only when the data key itself
/// is replaced, never on a password change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultIdentity {
    pub scope: VaultScope,
    pub vault_id: String,
    pub key_generation: String,
}

impl VaultIdentity {
    pub fn new(scope: VaultScope) -> Result<Self, String> {
        Ok(Self {
            scope,
            vault_id: new_hex_id()?,
            key_generation: new_hex_id()?,
        })
    }

    fn slot_aad(&self, method: &str, slot_id: &str) -> Vec<u8> {
        format!(
            "kivo:key-slot:v1:{}:{}:{}:{method}:{slot_id}",
            self.scope.as_str(),
            self.vault_id,
            self.key_generation
        )
        .into_bytes()
    }

    fn check_aad(&self) -> Vec<u8> {
        format!(
            "kivo:key-check:v1:{}:{}:{}",
            self.scope.as_str(),
            self.vault_id,
            self.key_generation
        )
        .into_bytes()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct KdfParams {
    algorithm: String,
    version: u32,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
}

impl KdfParams {
    fn approved() -> Self {
        Self {
            algorithm: "argon2id".to_string(),
            version: 19,
            memory_kib: KDF_MEMORY_KIB,
            iterations: KDF_ITERATIONS,
            parallelism: KDF_PARALLELISM,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct KeyEnvelope {
    version: u32,
    method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kdf: Option<KdfParams>,
    ciphertext: String,
}

/// 16 random bytes as lowercase hex.
pub fn new_hex_id() -> Result<String, String> {
    let bytes = new_vault_key()?;
    Ok(bytes[..16].iter().map(|byte| format!("{byte:02x}")).collect())
}

fn password_wrapping_key(password: &str, salt: &[u8]) -> Result<Zeroizing<DataKey>, String> {
    let params = Params::new(KDF_MEMORY_KIB, KDF_ITERATIONS, KDF_PARALLELISM, Some(32))
        .map_err(|_| "Could not protect the vault key".to_string())?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|_| "Could not protect the vault key".to_string())?;
    Ok(key)
}

/// A password slot's JSON: the data key sealed under an Argon2id key from the password.
pub fn wrap_with_password(
    identity: &VaultIdentity,
    slot_id: &str,
    data_key: &DataKey,
    password: &str,
) -> Result<String, String> {
    if password.trim().is_empty() {
        return Err("Password is required".to_string());
    }
    let salt = new_vault_key()?;
    let salt = &salt[..SALT_LEN];
    let wrapping = password_wrapping_key(password, salt)?;
    let sealed = encrypt_bytes(&wrapping, data_key, &identity.slot_aad("password", slot_id))?;
    serde_json::to_string(&KeyEnvelope {
        version: ENVELOPE_VERSION,
        method: "password".to_string(),
        salt: Some(STANDARD.encode(salt)),
        kdf: Some(KdfParams::approved()),
        ciphertext: STANDARD.encode(sealed),
    })
    .map_err(|_| "Could not protect the vault key".to_string())
}

/// Opens a password slot. `Ok(None)` means the password is wrong; `Err` means
/// the slot itself is malformed or uses parameters Kivo does not accept, which
/// is checked before any key derivation work.
pub fn unwrap_with_password(
    identity: &VaultIdentity,
    slot_id: &str,
    envelope_json: &str,
    password: &str,
) -> Result<Option<DataKey>, String> {
    if envelope_json.len() > MAX_ENVELOPE_JSON {
        return Err(DAMAGED.to_string());
    }
    let envelope: KeyEnvelope = serde_json::from_str(envelope_json).map_err(|_| DAMAGED.to_string())?;
    if envelope.version != ENVELOPE_VERSION
        || envelope.method != "password"
        || envelope.kdf.as_ref() != Some(&KdfParams::approved())
    {
        return Err(DAMAGED.to_string());
    }
    let salt = envelope
        .salt
        .as_deref()
        .and_then(|salt| STANDARD.decode(salt).ok())
        .filter(|salt| salt.len() == SALT_LEN)
        .ok_or_else(|| DAMAGED.to_string())?;
    let sealed = STANDARD.decode(&envelope.ciphertext).map_err(|_| DAMAGED.to_string())?;
    if sealed.len() != 12 + 32 + 16 {
        return Err(DAMAGED.to_string());
    }
    let wrapping = password_wrapping_key(password, &salt)?;
    let Ok(plain) = decrypt_bytes(&wrapping, &sealed, &identity.slot_aad("password", slot_id)) else {
        return Ok(None);
    };
    let plain = Zeroizing::new(plain);
    let key: DataKey = plain.as_slice().try_into().map_err(|_| DAMAGED.to_string())?;
    Ok(Some(key))
}

/// Proves a data key belongs to this vault identity, even for an empty vault.
pub fn make_key_check(identity: &VaultIdentity, data_key: &DataKey) -> Result<Vec<u8>, String> {
    encrypt_bytes(data_key, KEY_CHECK_PLAINTEXT, &identity.check_aad())
}

pub fn key_check_matches(identity: &VaultIdentity, data_key: &DataKey, stored: &[u8]) -> bool {
    decrypt_bytes(data_key, stored, &identity.check_aad()).is_ok_and(|plain| plain == KEY_CHECK_PLAINTEXT)
}

// ---- Storage ----

/// The vault's identity and key check, when it has moved to v1 slots.
pub fn read_identity(
    connection: &Connection,
    scope: VaultScope,
) -> Result<Option<(VaultIdentity, Vec<u8>)>, String> {
    connection
        .query_row(
            "SELECT vault_id, key_generation, key_check FROM vault_keys WHERE scope = ?1",
            params![scope.as_str()],
            |row| {
                Ok((
                    VaultIdentity {
                        scope,
                        vault_id: row.get(0)?,
                        key_generation: row.get(1)?,
                    },
                    row.get(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Could not read the vault keys: {error}"))
}

fn read_slot(connection: &Connection, scope: VaultScope, method: &str) -> Result<Option<(String, String)>, String> {
    connection
        .query_row(
            "SELECT slot_id, envelope_json FROM vault_key_slots WHERE scope = ?1 AND method = ?2",
            params![scope.as_str(), method],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("Could not read the vault keys: {error}"))
}

/// Whether this vault unlocks through v1 slots (rather than its legacy format).
pub fn has_slots(connection: &Connection, scope: VaultScope) -> Result<bool, String> {
    Ok(read_identity(connection, scope)?.is_some())
}

/// Unlocks a v1 vault with its password. `Ok(None)` is a wrong password. A
/// missing or damaged slot, or a key that fails the key check, is an error:
/// it never falls back to an older unlock route.
pub fn unlock_with_password(
    connection: &Connection,
    scope: VaultScope,
    password: &str,
) -> Result<Option<DataKey>, String> {
    let (identity, check) = read_identity(connection, scope)?.ok_or_else(|| DAMAGED.to_string())?;
    let (slot_id, envelope) = read_slot(connection, scope, "password")?.ok_or_else(|| DAMAGED.to_string())?;
    let Some(key) = unwrap_with_password(&identity, &slot_id, &envelope, password)? else {
        return Ok(None);
    };
    if !key_check_matches(&identity, &key, &check) {
        return Err(DAMAGED.to_string());
    }
    Ok(Some(key))
}

/// Gives a vault a fresh identity and a password slot around `data_key`,
/// replacing whatever it had. Call inside the caller's transaction.
pub fn install_password_slot(
    connection: &Connection,
    scope: VaultScope,
    data_key: &DataKey,
    password: &str,
) -> Result<VaultIdentity, String> {
    let identity = VaultIdentity::new(scope)?;
    let slot_id = new_hex_id()?;
    let envelope = wrap_with_password(&identity, &slot_id, data_key, password)?;
    let check = make_key_check(&identity, data_key)?;
    let fail = |error: rusqlite::Error| format!("Could not save the vault keys: {error}");
    connection
        .execute("DELETE FROM vault_keys WHERE scope = ?1", params![scope.as_str()])
        .map_err(fail)?;
    connection
        .execute(
            "INSERT INTO vault_keys (scope, vault_id, key_generation, format, key_check)
             VALUES (?1, ?2, ?3, 1, ?4)",
            params![scope.as_str(), identity.vault_id, identity.key_generation, check],
        )
        .map_err(fail)?;
    connection
        .execute(
            "INSERT INTO vault_key_slots (scope, method, slot_id, envelope_json)
             VALUES (?1, 'password', ?2, ?3)",
            params![scope.as_str(), slot_id, envelope],
        )
        .map_err(fail)?;
    Ok(identity)
}

/// Replaces only the password slot; the data key, identity and any other
/// slots stay. Call inside the caller's transaction.
pub fn replace_password_slot(
    connection: &Connection,
    scope: VaultScope,
    data_key: &DataKey,
    password: &str,
) -> Result<(), String> {
    let (identity, check) = read_identity(connection, scope)?.ok_or_else(|| DAMAGED.to_string())?;
    if !key_check_matches(&identity, data_key, &check) {
        return Err(DAMAGED.to_string());
    }
    let slot_id = new_hex_id()?;
    let envelope = wrap_with_password(&identity, &slot_id, data_key, password)?;
    connection
        .execute(
            "INSERT INTO vault_key_slots (scope, method, slot_id, envelope_json)
             VALUES (?1, 'password', ?2, ?3)
             ON CONFLICT(scope, method) DO UPDATE SET
               slot_id = excluded.slot_id, envelope_json = excluded.envelope_json",
            params![scope.as_str(), slot_id, envelope],
        )
        .map_err(|error| format!("Could not save the vault keys: {error}"))?;
    Ok(())
}

/// Removes a vault's identity and every slot (they cascade).
pub fn remove_scope(connection: &Connection, scope: VaultScope) -> Result<(), String> {
    connection
        .execute("DELETE FROM vault_keys WHERE scope = ?1", params![scope.as_str()])
        .map(|_| ())
        .map_err(|error| format!("Could not remove the vault keys: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(scope: VaultScope) -> VaultIdentity {
        VaultIdentity::new(scope).unwrap()
    }

    #[test]
    fn password_slot_round_trips_and_rejects_a_wrong_password() {
        let id = identity(VaultScope::Content);
        let key = new_vault_key().unwrap();
        let json = wrap_with_password(&id, "slot", &key, "correct horse").unwrap();

        assert_eq!(unwrap_with_password(&id, "slot", &json, "correct horse").unwrap(), Some(key));
        assert_eq!(unwrap_with_password(&id, "slot", &json, "wrong").unwrap(), None);
        assert!(!json.contains(&STANDARD.encode(key)), "no raw key in the slot");
    }

    #[test]
    fn a_slot_only_opens_for_its_own_identity_method_and_slot_id() {
        let id = identity(VaultScope::Content);
        let key = new_vault_key().unwrap();
        let json = wrap_with_password(&id, "slot", &key, "pw").unwrap();

        let other_scope = VaultIdentity { scope: VaultScope::Passwords, ..id.clone() };
        let other_vault = VaultIdentity { vault_id: new_hex_id().unwrap(), ..id.clone() };
        let other_generation = VaultIdentity { key_generation: new_hex_id().unwrap(), ..id.clone() };
        for wrong in [&other_scope, &other_vault, &other_generation] {
            assert_eq!(unwrap_with_password(wrong, "slot", &json, "pw").unwrap(), None);
        }
        assert_eq!(unwrap_with_password(&id, "other-slot", &json, "pw").unwrap(), None);
        let as_recovery = json.replace("\"method\":\"password\"", "\"method\":\"recovery\"");
        assert!(unwrap_with_password(&id, "slot", &as_recovery, "pw").is_err());
    }

    #[test]
    fn tampered_or_unexpected_envelopes_are_refused_before_any_work() {
        let id = identity(VaultScope::Content);
        let key = new_vault_key().unwrap();
        let json = wrap_with_password(&id, "slot", &key, "pw").unwrap();
        let mut envelope: serde_json::Value = serde_json::from_str(&json).unwrap();

        let mut flipped = STANDARD.decode(envelope["ciphertext"].as_str().unwrap()).unwrap();
        *flipped.last_mut().unwrap() ^= 1;
        let mut tampered = envelope.clone();
        tampered["ciphertext"] = STANDARD.encode(flipped).into();
        assert_eq!(unwrap_with_password(&id, "slot", &tampered.to_string(), "pw").unwrap(), None);

        let mut cases = Vec::new();
        let mut future = envelope.clone();
        future["version"] = 2.into();
        cases.push(future);
        let mut extra = envelope.clone();
        extra["note"] = "hi".into();
        cases.push(extra);
        let mut weak = envelope.clone();
        weak["kdf"]["memoryKib"] = 8.into();
        cases.push(weak);
        let mut huge = envelope.clone();
        huge["kdf"]["memoryKib"] = 4_000_000.into();
        cases.push(huge);
        let mut bad_salt = envelope.clone();
        bad_salt["salt"] = "!!".into();
        cases.push(bad_salt);
        envelope["ciphertext"] = STANDARD.encode([0u8; 10]).into();
        cases.push(envelope);
        for case in cases {
            assert!(unwrap_with_password(&id, "slot", &case.to_string(), "pw").is_err(), "{case}");
        }
        assert!(unwrap_with_password(&id, "slot", &"x".repeat(MAX_ENVELOPE_JSON + 1), "pw").is_err());
        assert!(unwrap_with_password(&id, "slot", "not json", "pw").is_err());
    }

    #[test]
    fn every_wrap_uses_a_fresh_salt_and_nonce() {
        let id = identity(VaultScope::Passwords);
        let key = new_vault_key().unwrap();
        assert_ne!(
            wrap_with_password(&id, "slot", &key, "pw").unwrap(),
            wrap_with_password(&id, "slot", &key, "pw").unwrap()
        );
    }

    #[test]
    fn key_check_proves_the_key_and_identity_even_for_an_empty_vault() {
        let id = identity(VaultScope::Content);
        let key = new_vault_key().unwrap();
        let check = make_key_check(&id, &key).unwrap();

        assert!(key_check_matches(&id, &key, &check));
        assert!(!key_check_matches(&id, &new_vault_key().unwrap(), &check));
        let moved = VaultIdentity { vault_id: new_hex_id().unwrap(), ..id.clone() };
        assert!(!key_check_matches(&moved, &key, &check));
        let mut altered = check.clone();
        *altered.last_mut().unwrap() ^= 1;
        assert!(!key_check_matches(&id, &key, &altered));
    }
}
