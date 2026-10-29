use std::path::Path;

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == "node_modules" || name_str == ".DS_Store" || name_str == "target" {
            continue;
        }
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(&name))?;
        } else {
            std::fs::copy(entry.path(), dst.join(&name))?;
        }
    }
    Ok(())
}

fn prepare_bundled_plugins() {
    let plugins = [
        ("canvas", true),
        ("mindmap", true),
        ("kanban", true),
        ("literary-commentary", true),
        ("book-translation", true),
    ];
    let bundled_dir = Path::new("bundled-plugins");
    std::fs::create_dir_all(bundled_dir).ok();

    for (id, has_dist) in &plugins {
        let src_dir = Path::new("..").join("plugins").join(id);
        let dest_dir = bundled_dir.join(id);

        if !src_dir.exists() {
            continue;
        }

        if dest_dir.exists() {
            std::fs::remove_dir_all(&dest_dir).ok();
        }
        std::fs::create_dir_all(&dest_dir).ok();

        let manifest_src = src_dir.join("manifest.toml");
        if manifest_src.exists() {
            std::fs::copy(&manifest_src, dest_dir.join("manifest.toml")).ok();
        }

        if *has_dist {
            let dist_src = src_dir.join("dist");
            if dist_src.exists() {
                copy_dir_all(&dist_src, &dest_dir).ok();
            }
        }

        let index_src = src_dir.join("index.js");
        if index_src.exists() {
            std::fs::copy(&index_src, dest_dir.join("index.js")).ok();
        }
    }

    println!("cargo:rerun-if-changed=../plugins/canvas/manifest.toml");
    println!("cargo:rerun-if-changed=../plugins/canvas/dist/");
    println!("cargo:rerun-if-changed=../plugins/mindmap/manifest.toml");
    println!("cargo:rerun-if-changed=../plugins/mindmap/dist/");
    println!("cargo:rerun-if-changed=../plugins/kanban/manifest.toml");
    println!("cargo:rerun-if-changed=../plugins/kanban/dist/");
    println!("cargo:rerun-if-changed=../plugins/literary-commentary/manifest.toml");
    println!("cargo:rerun-if-changed=../plugins/literary-commentary/dist/");
    println!("cargo:rerun-if-changed=../plugins/book-translation/manifest.toml");
    println!("cargo:rerun-if-changed=../plugins/book-translation/dist/");
}

fn prepare_bundled_templates() {
    // Bundled snippet-templates live under `core/bundled-templates/` and are
    // declared as Tauri resources in `tauri.conf.json`. We keep them in the
    // crate directory (checked into git) so there's no copy step, but still
    // re-run the build script when any of them change.
    let dir = Path::new("bundled-templates");
    if !dir.exists() {
        return;
    }
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = entry.path();
        if p.is_file() {
            println!("cargo:rerun-if-changed={}", p.display());
        }
    }
}

/// Android keeps bundle resources inside the APK, where `std::fs` cannot read
/// them, so the app embeds `bundled-plugins/` and `bundled-templates/` and
/// extracts them at startup (`services::bundled_resources`). Other targets read
/// the bundle's resource directory and get no generated table.
fn embed_bundled_resources_for_android() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("android") {
        return;
    }
    let crate_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let mut files = Vec::new();
    for root in ["bundled-plugins", "bundled-templates"] {
        collect_files(&crate_dir, &crate_dir.join(root), &mut files);
    }
    files.sort();

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut table = String::new();
    for relative in &files {
        let absolute = crate_dir.join(relative);
        let bytes = std::fs::read(&absolute).expect("read bundled resource");
        std::hash::Hash::hash(relative, &mut hasher);
        std::hash::Hash::hash(&bytes, &mut hasher);
        table.push_str(&format!(
            "    ({relative:?}, include_bytes!({:?})),\n",
            absolute.to_string_lossy()
        ));
    }
    let fingerprint = std::hash::Hasher::finish(&hasher);
    let source = format!(
        "const FINGERPRINT: &str = \"{fingerprint:016x}-{}\";\nstatic FILES: &[(&str, &[u8])] = &[\n{table}];\n",
        files.len()
    );
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    std::fs::write(out.join("bundled_resources.rs"), source)
        .expect("write embedded bundled resources table");
}

/// Resource-relative paths (forward slashes) of every file under `dir`.
fn collect_files(crate_dir: &Path, dir: &Path, files: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name() == ".DS_Store" {
            continue;
        }
        if path.is_dir() {
            collect_files(crate_dir, &path, files);
        } else if let Ok(relative) = path.strip_prefix(crate_dir) {
            let components: Vec<_> = relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect();
            files.push(components.join("/"));
        }
    }
}

fn main() {
    prepare_bundled_plugins();
    prepare_bundled_templates();
    embed_bundled_resources_for_android();
    tauri_build::build()
}
