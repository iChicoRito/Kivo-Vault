#![allow(dead_code)]

#[path = "../src/database.rs"]
mod database;
#[path = "../src/encryption.rs"]
mod encryption;
#[path = "../src/key_slots.rs"]
mod key_slots;
#[path = "../src/security.rs"]
mod security;

use encryption::{
    decrypt_bytes, encrypt_bytes, new_vault_key, unwrap_vault_key, wrap_vault_key, ContentKeyState,
};

const PASSWORD: &str = "correct horse battery staple";

#[test]
fn wrapped_key_unlocks_only_with_the_right_password() {
    let key = new_vault_key().expect("generate a key");
    let wrapped = wrap_vault_key(&key, PASSWORD).expect("wrap key");

    assert_eq!(
        unwrap_vault_key(&wrapped.salt, &wrapped.wrapped, PASSWORD).unwrap(),
        key
    );
    assert!(unwrap_vault_key(&wrapped.salt, &wrapped.wrapped, "wrong password").is_err());
    assert!(!wrapped.wrapped.windows(key.len()).any(|part| part == key));
}

#[test]
fn tampered_wrapped_key_does_not_unlock() {
    let key = new_vault_key().expect("generate a key");
    let mut wrapped = wrap_vault_key(&key, PASSWORD).expect("wrap key");
    *wrapped.wrapped.last_mut().unwrap() ^= 1;

    assert!(unwrap_vault_key(&wrapped.salt, &wrapped.wrapped, PASSWORD).is_err());
}

#[test]
fn each_value_has_a_fresh_nonce_and_is_bound_to_its_record() {
    let key = new_vault_key().expect("generate a key");
    let first = encrypt_bytes(&key, b"private note", b"kivo:item:one:v1").unwrap();
    let second = encrypt_bytes(&key, b"private note", b"kivo:item:one:v1").unwrap();

    assert_ne!(first, second);
    assert_eq!(
        decrypt_bytes(&key, &first, b"kivo:item:one:v1").unwrap(),
        b"private note"
    );
    assert!(decrypt_bytes(&key, &first, b"kivo:item:two:v1").is_err());

    let mut altered = first;
    *altered.last_mut().unwrap() ^= 1;
    assert!(decrypt_bytes(&key, &altered, b"kivo:item:one:v1").is_err());
}

#[test]
fn malformed_ciphertexts_and_salts_are_rejected() {
    let key = new_vault_key().expect("generate a key");
    assert!(decrypt_bytes(&key, b"too short", b"kivo:item:one:v1").is_err());
    assert!(unwrap_vault_key(b"tiny", b"too short", PASSWORD).is_err());
}

#[test]
fn locking_discards_the_in_memory_key() {
    let state = ContentKeyState::default();
    let key = new_vault_key().unwrap();

    assert!(state.require_key().is_err());
    state.store(key).unwrap();
    assert_eq!(state.require_key().unwrap(), key);
    state.clear().unwrap();
    assert!(state.require_key().is_err());
}

#[test]
fn blank_password_cannot_wrap_a_new_vault_key() {
    let key = new_vault_key().unwrap();
    assert!(wrap_vault_key(&key, "  ").is_err());
}
