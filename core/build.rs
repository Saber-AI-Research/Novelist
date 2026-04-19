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
    let plugins = [("canvas", true), ("mindmap", true), ("kanban", true)];
    let bundled_dir = Path::new("bundled-plugins");
    std::fs::create_dir_all(bundled_dir).ok();

    for (id, has_dist) in &plugins {
        let src_dir = Path::new("..").join("plugins").join(id);
        let dest_dir = bundled_dir.join(id);

        if !src_dir.exists() {
            continue;
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
}

fn main() {
    prepare_bundled_plugins();
    tauri_build::build()
}
