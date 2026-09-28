mod backup;
mod database;
mod encryption;
mod icons;
mod insights;
mod passwords;
mod portability;
mod security;
mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            use tauri::Manager;

            let data_dir = app.path().app_local_data_dir()?;
            let database =
                database::DatabaseState::new(data_dir.join("kivo.db"), data_dir.join("files"));

            // Try migration during startup. Failed attempts remain retryable through the command.
            let _ = database.initialize();
            app.manage(database);
            app.manage(passwords::VaultKeyState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            database::initialize_database,
            database::load_boot_state,
            database::complete_setup,
            database::load_profile,
            database::save_profile,
            database::load_preferences,
            database::save_preferences,
            database::set_password_verifier,
            database::remove_password_verifier,
            database::load_password_verifier,
            database::has_password_verifier,
            passwords::reset_requires_password,
            passwords::reset_vault,
            passwords::verify_reset_password,
            security::hash_password,
            security::verify_password,
            encryption::read_protection_state,
            encryption::unlock_content_vault,
            encryption::lock_content_vault,
            encryption::enable_encryption,
            encryption::disable_encryption,
            encryption::change_master_password,
            backup::pick_backup_destination,
            backup::create_backup,
            backup::create_backup_now,
            backup::pick_backup_source,
            backup::inspect_backup,
            backup::restore_backup,
            portability::pick_save_file,
            portability::pick_folder_destination,
            portability::export_note_markdown,
            portability::export_items_json,
            portability::export_vault_json,
            portability::import_json,
            portability::import_markdown,
            vault::import_file,
            vault::index_file,
            vault::save_item,
            vault::load_item,
            vault::list_items,
            vault::set_item_tags,
            vault::list_collections,
            vault::list_item_versions,
            vault::restore_item_version,
            vault::read_item_file,
            vault::load_storage_report,
            vault::list_index_state,
            vault::set_item_pinned,
            vault::set_items_favorite,
            vault::move_items_to_collection,
            vault::trash_items,
            vault::restore_items,
            vault::delete_items_permanently,
            vault::load_vault_summary,
            vault::save_collection,
            vault::delete_collection,
            vault::verify_collection_secret,
            vault::list_tags,
            vault::pick_file,
            vault::pick_files,
            vault::open_item_file,
            vault::reveal_item_file,
            vault::open_source_url,
            insights::search_related_items,
            insights::reindex_items,
            insights::suggest_tags,
            insights::summarize_item,
            icons::credential_icon,
            passwords::vault_status,
            passwords::setup_vault,
            passwords::unlock_vault,
            passwords::lock_vault,
            passwords::list_credentials,
            passwords::load_credential,
            passwords::save_credential,
            passwords::set_credentials_favorite,
            passwords::trash_credentials,
            passwords::restore_credentials,
            passwords::delete_credentials_permanently,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kivo")
}
