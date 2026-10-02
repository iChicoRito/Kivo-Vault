use argon2::{
    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},
    Argon2,
};

/// Shared argon2 work. The app lock and the collection secrets both hash and
/// verify through these two so the stored format stays one format.
pub(crate) fn hash_secret(secret: &str) -> Result<String, String> {
    let verifier = Argon2::default()
        .hash_password(secret.as_bytes())
        .map_err(|_| "Could not protect the secret".to_string())?;

    Ok(verifier.to_string())
}

pub(crate) fn secret_matches(secret: &str, verifier: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(verifier) else {
        return false;
    };

    Argon2::default()
        .verify_password(secret.as_bytes(), &parsed)
        .is_ok()
}

#[tauri::command(async)]
pub fn hash_password(password: String) -> Result<String, String> {
    if password.trim().is_empty() {
        return Err("Password is required".to_string());
    }

    hash_secret(&password)
}

#[tauri::command(async)]
pub fn verify_password(password: String, verifier: String) -> Result<bool, String> {
    Ok(secret_matches(&password, &verifier))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "correct horse battery staple";

    fn hash(password: &str) -> String {
        hash_password(password.to_string()).expect("hash password")
    }

    #[test]
    fn hash_password_returns_an_argon2id_phc_verifier_without_the_password() {
        let verifier = hash(PASSWORD);

        assert!(verifier.starts_with("$argon2id$"));
        assert!(!verifier.contains(PASSWORD));
    }

    #[test]
    fn verify_password_accepts_the_correct_password() {
        let verifier = hash(PASSWORD);

        assert!(verify_password(PASSWORD.to_string(), verifier).expect("verify password"));
    }

    #[test]
    fn verify_password_rejects_a_wrong_password() {
        let verifier = hash(PASSWORD);

        assert!(!verify_password("wrong password".to_string(), verifier).expect("verify password"));
    }

    #[test]
    fn hash_password_uses_a_unique_salt_and_hash_for_the_same_password() {
        let first = hash(PASSWORD);
        let second = hash(PASSWORD);

        assert_ne!(first, second);
        assert!(verify_password(PASSWORD.to_string(), first).expect("verify first"));
        assert!(verify_password(PASSWORD.to_string(), second).expect("verify second"));
    }

    #[test]
    fn verify_password_rejects_malformed_and_foreign_verifiers_without_echoing_them() {
        assert_eq!(
            verify_password(PASSWORD.to_string(), "not-a-phc-string".to_string()),
            Ok(false)
        );

        let foreign = "$pbkdf2-sha256$i=600000,l=32$c2FsdA$aGFzaA".to_string();
        assert_eq!(verify_password(PASSWORD.to_string(), foreign), Ok(false));
    }

    #[test]
    fn hash_password_rejects_empty_and_whitespace_only_passwords() {
        for blank in ["", "   ", "\t\n"] {
            let error =
                hash_password(blank.to_string()).expect_err("blank password must be rejected");

            assert!(
                error.contains("required"),
                "unexpected error message: {error}"
            );
            assert!(
                !error.contains("$argon2id$"),
                "error must not echo a verifier"
            );
        }
    }
}
