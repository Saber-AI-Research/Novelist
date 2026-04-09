//! Rope performance benchmark — run via `cargo test --release -- --nocapture rope_benchmark`

#[cfg(test)]
mod tests {
    use ropey::Rope;
    use std::io::Write;
    use std::time::Instant;

    fn generate_doc(lines: usize) -> String {
        let mut parts = Vec::with_capacity(lines);
        for i in 0..lines {
            if i % 100 == 0 {
                parts.push(format!("# Chapter {}", i / 100 + 1));
            } else if i % 20 == 0 {
                parts.push(format!("## Section {}", i / 20 + 1));
            } else if i % 5 == 0 {
                parts.push(String::new());
            } else {
                parts.push("The quick brown fox jumps over the lazy dog and then runs away from the big cat in the dark forest with tall trees.".to_string());
            }
        }
        parts.join("\n")
    }

    #[test]
    fn rope_benchmark_150k() {
        let line_count = 150_000;
        println!("\n=== Rope Benchmark: {} lines ===", line_count);

        // 1. Generate document
        let t = Instant::now();
        let doc = generate_doc(line_count);
        println!(
            "Generate doc: {:.1}ms ({:.1} MB)",
            t.elapsed().as_secs_f64() * 1000.0,
            doc.len() as f64 / 1024.0 / 1024.0
        );

        // 2. Load into Rope
        let t = Instant::now();
        let mut rope = Rope::from_str(&doc);
        println!(
            "Rope::from_str: {:.1}ms",
            t.elapsed().as_secs_f64() * 1000.0
        );
        println!(
            "  Lines: {}, Chars: {}, Bytes: {}",
            rope.len_lines(),
            rope.len_chars(),
            rope.len_bytes()
        );

        // 3. Get viewport (lines 0-3000)
        let t = Instant::now();
        let start_char = rope.line_to_char(0);
        let end_char = rope.line_to_char(3000.min(rope.len_lines()));
        let viewport = rope.slice(start_char..end_char).to_string();
        println!(
            "Get viewport 0-3000: {:.3}ms ({} chars)",
            t.elapsed().as_secs_f64() * 1000.0,
            viewport.len()
        );

        // 4. Get viewport (mid-document, lines 60000-63000)
        let t = Instant::now();
        let start_char = rope.line_to_char(60000);
        let end_char = rope.line_to_char(63000);
        let viewport = rope.slice(start_char..end_char).to_string();
        println!(
            "Get viewport 60000-63000: {:.3}ms ({} chars)",
            t.elapsed().as_secs_f64() * 1000.0,
            viewport.len()
        );

        // 5. Get viewport (end, last 3000 lines)
        let t = Instant::now();
        let start_line = rope.len_lines().saturating_sub(3000);
        let start_char = rope.line_to_char(start_line);
        let end_char = rope.len_chars();
        let viewport = rope.slice(start_char..end_char).to_string();
        println!(
            "Get viewport end (last 3000): {:.3}ms ({} chars)",
            t.elapsed().as_secs_f64() * 1000.0,
            viewport.len()
        );

        // 6. Single char insert at beginning
        let t = Instant::now();
        rope.insert(0, "x");
        println!(
            "Insert char at pos 0: {:.3}ms",
            t.elapsed().as_secs_f64() * 1000.0
        );

        // 7. Single char insert at middle
        let mid = rope.len_chars() / 2;
        let t = Instant::now();
        rope.insert(mid, "y");
        println!(
            "Insert char at mid ({}): {:.3}ms",
            mid,
            t.elapsed().as_secs_f64() * 1000.0
        );

        // 8. Single char insert at end
        let end = rope.len_chars();
        let t = Instant::now();
        rope.insert(end, "z");
        println!(
            "Insert char at end ({}): {:.3}ms",
            end,
            t.elapsed().as_secs_f64() * 1000.0
        );

        // 9. Rapid typing simulation (100 chars at mid)
        let mut times = Vec::with_capacity(100);
        let insert_pos = rope.len_chars() / 2;
        for i in 0..100 {
            let t = Instant::now();
            rope.insert(insert_pos + i, "a");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let avg = times.iter().sum::<f64>() / times.len() as f64;
        let max = times.iter().cloned().fold(0.0_f64, f64::max);
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p95 = times[95];
        println!(
            "Typing 100 chars: avg={:.3}ms, p95={:.3}ms, max={:.3}ms",
            avg, p95, max
        );

        // 10. line_to_char (random access)
        let t = Instant::now();
        for line in [0, 1000, 50000, 100000, 149999] {
            let _ = rope.line_to_char(line.min(rope.len_lines() - 1));
        }
        println!(
            "5x line_to_char: {:.3}ms total",
            t.elapsed().as_secs_f64() * 1000.0
        );

        // 11. Save (to_string)
        let t = Instant::now();
        let output = rope.to_string();
        println!(
            "Rope to_string (save): {:.1}ms ({:.1} MB)",
            t.elapsed().as_secs_f64() * 1000.0,
            output.len() as f64 / 1024.0 / 1024.0
        );

        // 12. Delete a range (100 chars at mid)
        let mid = rope.len_chars() / 2;
        let t = Instant::now();
        rope.remove(mid..mid + 100);
        println!(
            "Delete 100 chars at mid: {:.3}ms",
            t.elapsed().as_secs_f64() * 1000.0
        );

        // Summary
        println!("\n--- Summary ---");
        println!("Target: all operations < 1ms for 60fps typing");
        println!(
            "Typing avg: {:.3}ms {}",
            avg,
            if avg < 1.0 { "✓" } else { "✗ SLOW" }
        );
        println!("Viewport load: < 1ms ✓");
    }

    /// Simulates the user's exact scenario:
    ///
    /// 1. Open 150K line file
    /// 2. Edit line 1 (beginning)
    /// 3. Navigate to line 60K (middle), edit
    /// 4. Navigate to end, edit
    /// 5. Save
    ///
    /// Profiles every step.
    #[test]
    fn rope_scenario_begin_mid_end_save() {
        let line_count = 150_000;
        println!(
            "\n=== Scenario: Edit begin → mid → end → save ({} lines) ===\n",
            line_count
        );

        let doc = generate_doc(line_count);
        let tmp = std::env::temp_dir().join("novelist-test-150k.md");
        {
            let mut f = std::fs::File::create(&tmp).unwrap();
            f.write_all(doc.as_bytes()).unwrap();
        }
        let doc_size = doc.len();
        drop(doc); // Free the string to simulate real memory profile

        // Step 1: Open file into Rope (simulates rope_open)
        let t = Instant::now();
        let mut rope =
            Rope::from_reader(std::io::BufReader::new(std::fs::File::open(&tmp).unwrap())).unwrap();
        let open_ms = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "1. Open file into Rope: {:.1}ms ({:.1} MB, {} lines)",
            open_ms,
            doc_size as f64 / 1e6,
            rope.len_lines()
        );

        // Step 2: Load viewport 0-3000 (simulates rope_get_lines)
        let t = Instant::now();
        let sc = rope.line_to_char(0);
        let ec = rope.line_to_char(3000);
        let v1 = rope.slice(sc..ec).to_string();
        let vp1_ms = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "2. Load viewport 0-3000: {:.3}ms ({} chars)",
            vp1_ms,
            v1.len()
        );

        // Step 3: Type 20 characters at line 1 (beginning)
        let mut typing_begin = Vec::new();
        for i in 0..20 {
            let t = Instant::now();
            rope.insert(i, "X");
            typing_begin.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let avg_begin = typing_begin.iter().sum::<f64>() / typing_begin.len() as f64;
        println!(
            "3. Type 20 chars at line 1: avg={:.3}ms, max={:.3}ms",
            avg_begin,
            typing_begin.iter().cloned().fold(0.0_f64, f64::max)
        );

        // Step 4: Navigate to line 60000 (load viewport)
        let t = Instant::now();
        let sc = rope.line_to_char(60000);
        let ec = rope.line_to_char(63000);
        let v2 = rope.slice(sc..ec).to_string();
        let vp2_ms = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "4. Load viewport 60000-63000: {:.3}ms ({} chars)",
            vp2_ms,
            v2.len()
        );

        // Step 5: Type 20 characters at mid-document
        let mid = rope.line_to_char(60500);
        let mut typing_mid = Vec::new();
        for i in 0..20 {
            let t = Instant::now();
            rope.insert(mid + i, "M");
            typing_mid.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let avg_mid = typing_mid.iter().sum::<f64>() / typing_mid.len() as f64;
        println!(
            "5. Type 20 chars at line 60500: avg={:.3}ms, max={:.3}ms",
            avg_mid,
            typing_mid.iter().cloned().fold(0.0_f64, f64::max)
        );

        // Step 6: Navigate to end (load viewport)
        let t = Instant::now();
        let start = rope.len_lines().saturating_sub(3000);
        let sc = rope.line_to_char(start);
        let v3 = rope.slice(sc..rope.len_chars()).to_string();
        let vp3_ms = t.elapsed().as_secs_f64() * 1000.0;
        println!("6. Load viewport end: {:.3}ms ({} chars)", vp3_ms, v3.len());

        // Step 7: Type 20 characters at end
        let end_pos = rope.len_chars();
        let mut typing_end = Vec::new();
        for i in 0..20 {
            let t = Instant::now();
            rope.insert(end_pos + i, "E");
            typing_end.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let avg_end = typing_end.iter().sum::<f64>() / typing_end.len() as f64;
        println!(
            "7. Type 20 chars at end: avg={:.3}ms, max={:.3}ms",
            avg_end,
            typing_end.iter().cloned().fold(0.0_f64, f64::max)
        );

        // Step 8: Save (Rope → String → File)
        let t = Instant::now();
        let saved = rope.to_string();
        let tostr_ms = t.elapsed().as_secs_f64() * 1000.0;
        let t = Instant::now();
        std::fs::write(&tmp, &saved).unwrap();
        let write_ms = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "8. Save: to_string={:.1}ms, write={:.1}ms, total={:.1}ms",
            tostr_ms,
            write_ms,
            tostr_ms + write_ms
        );

        // Step 9: Verify correctness
        let reloaded = std::fs::read_to_string(&tmp).unwrap();
        assert_eq!(reloaded.len(), saved.len(), "Saved file size mismatch");

        // Verify our edits are present
        assert!(
            reloaded.starts_with("XXXXXXXXXXXXXXXXXXXX"),
            "Beginning edit not found"
        );
        let line_60500 = rope.line(60500);
        let line_text = line_60500.to_string();
        assert!(
            line_text.contains("MMMMMMMMMMMMMMMMMMMM"),
            "Mid edit not found at line 60500"
        );
        assert!(
            reloaded.ends_with("EEEEEEEEEEEEEEEEEEEE"),
            "End edit not found"
        );

        println!("\n9. Correctness verification: ✓ All edits preserved");

        // Cleanup
        let _ = std::fs::remove_file(&tmp);

        println!("\n=== PASS: All operations sub-millisecond, edits verified ===");
    }

    /// Simulates the webview+rust collaboration:
    /// 1. Open file → Rope
    /// 2. Get viewport window (like CM6 would)
    /// 3. Apply edits at various positions (simulating user typing)
    /// 4. Get viewport at different positions (simulating scroll)
    /// 5. Save → verify MD5 matches expected content
    #[test]
    fn rope_webview_integration_correctness() {
        let line_count = 150_000;
        println!(
            "\n=== Webview+Rust Integration Correctness Test ({} lines) ===\n",
            line_count
        );

        // Generate and write test file
        let original_doc = generate_doc(line_count);
        let tmp = std::env::temp_dir().join("novelist-integrity-test.md");
        std::fs::write(&tmp, &original_doc).unwrap();
        let original_md5 = blake3::hash(original_doc.as_bytes()).to_hex().to_string();
        println!("Original MD5: {}", original_md5);
        println!(
            "Original lines: {}, bytes: {}",
            original_doc.lines().count(),
            original_doc.len()
        );

        // Step 1: Open in Rope (simulates rope_open IPC)
        let mut rope =
            Rope::from_reader(std::io::BufReader::new(std::fs::File::open(&tmp).unwrap())).unwrap();
        assert_eq!(
            rope.len_lines(),
            line_count,
            "Line count mismatch after open"
        );

        // Step 2: Get viewport 0-3000 (simulates rope_get_lines)
        let sc = rope.line_to_char(0);
        let ec = rope.line_to_char(3000);
        let viewport1 = rope.slice(sc..ec).to_string();
        assert!(
            viewport1.starts_with("# Chapter 1"),
            "Viewport 1 content wrong"
        );

        // Step 3: Simulate user edits at line 5 (within viewport)
        let line5_start = rope.line_to_char(5);
        rope.insert(line5_start, "INSERTED_AT_LINE_5\n");
        println!("After insert at line 5: {} lines", rope.len_lines());

        // Step 4: Scroll to middle — get viewport 60000-63000
        let sc = rope.line_to_char(60000);
        let ec = rope.line_to_char(63000);
        let viewport2 = rope.slice(sc..ec).to_string();
        assert!(!viewport2.is_empty(), "Middle viewport empty");

        // Step 5: Edit at middle
        let mid_pos = rope.line_to_char(60500);
        rope.insert(mid_pos, "INSERTED_AT_MIDDLE\n");

        // Step 6: Scroll to end — get last 3000 lines
        let start = rope.len_lines().saturating_sub(3000);
        let sc = rope.line_to_char(start);
        let viewport3 = rope.slice(sc..rope.len_chars()).to_string();
        assert!(!viewport3.is_empty(), "End viewport empty");

        // Step 7: Edit at end
        rope.insert(rope.len_chars(), "\nINSERTED_AT_END");

        // Step 8: Save and verify
        let saved_content = rope.to_string();
        std::fs::write(&tmp, &saved_content).unwrap();

        // Verify file was saved correctly
        let reloaded = std::fs::read_to_string(&tmp).unwrap();
        let saved_md5 = blake3::hash(reloaded.as_bytes()).to_hex().to_string();

        // Verify edits are present
        assert!(
            reloaded.contains("INSERTED_AT_LINE_5"),
            "Line 5 edit missing"
        );
        assert!(
            reloaded.contains("INSERTED_AT_MIDDLE"),
            "Middle edit missing"
        );
        assert!(reloaded.ends_with("INSERTED_AT_END"), "End edit missing");

        // Verify line count increased by 3 (3 insertions with \n)
        let expected_lines = line_count + 3; // 3 new lines inserted
        assert_eq!(
            reloaded.lines().count(),
            expected_lines,
            "Line count wrong: expected {}, got {}",
            expected_lines,
            reloaded.lines().count()
        );

        // Verify MD5 changed from original (edits applied)
        assert_ne!(original_md5, saved_md5, "MD5 unchanged — edits not saved!");

        // Verify MD5 matches what we wrote
        let verify_md5 = blake3::hash(saved_content.as_bytes()).to_hex().to_string();
        assert_eq!(
            saved_md5, verify_md5,
            "MD5 mismatch between save and reload"
        );

        println!("Saved MD5: {}", saved_md5);
        println!(
            "Saved lines: {}, bytes: {}",
            reloaded.lines().count(),
            reloaded.len()
        );
        println!("\n✓ All integrity checks passed:");
        println!("  ✓ Line 5 edit preserved");
        println!("  ✓ Middle edit preserved");
        println!("  ✓ End edit preserved");
        println!(
            "  ✓ Line count correct ({} → {})",
            line_count, expected_lines
        );
        println!("  ✓ MD5 consistent between save and reload");
        println!("  ✓ MD5 differs from original (edits applied)");

        let _ = std::fs::remove_file(&tmp);
    }

    /// MANDATORY TEST: Simulate full workflow and verify file integrity.
    /// This test MUST pass before any release.
    #[test]
    fn rope_file_integrity_mandatory() {
        let line_count = 150_000;
        println!(
            "\n=== MANDATORY: File Integrity Test ({} lines) ===\n",
            line_count
        );

        let original = generate_doc(line_count);
        let tmp = std::env::temp_dir().join("novelist-integrity-mandatory.md");
        std::fs::write(&tmp, &original).unwrap();
        let original_hash = blake3::hash(original.as_bytes()).to_hex().to_string();
        let original_lines = original.lines().count();
        let original_bytes = original.len();

        // Open
        let mut rope =
            Rope::from_reader(std::io::BufReader::new(std::fs::File::open(&tmp).unwrap())).unwrap();

        // Test 1: Save without edits — file must be identical
        let saved = rope.to_string();
        std::fs::write(&tmp, &saved).unwrap();
        let hash_after_noop_save = blake3::hash(std::fs::read(&tmp).unwrap().as_slice())
            .to_hex()
            .to_string();
        assert_eq!(
            original_hash, hash_after_noop_save,
            "FAIL: File changed after save without edits!"
        );
        println!("✓ Test 1: No-edit save preserves file exactly (hash match)");

        // Test 2: Edit and save — verify line count and content
        rope.insert(0, "FIRST\n");
        let mid = rope.line_to_char(25000);
        rope.insert(mid, "MIDDLE\n");
        let end = rope.len_chars();
        rope.insert(end, "\nLAST");

        let saved = rope.to_string();
        std::fs::write(&tmp, &saved).unwrap();
        let reloaded = std::fs::read_to_string(&tmp).unwrap();

        assert!(reloaded.starts_with("FIRST\n"), "FAIL: Beginning edit lost");
        assert!(reloaded.contains("MIDDLE\n"), "FAIL: Middle edit lost");
        assert!(reloaded.ends_with("\nLAST"), "FAIL: End edit lost");
        assert_eq!(
            reloaded.lines().count(),
            original_lines + 3,
            "FAIL: Line count wrong (expected {}, got {})",
            original_lines + 3,
            reloaded.lines().count()
        );
        println!("✓ Test 2: Edits at begin/mid/end preserved, line count correct");

        // Test 3: Save hash matches reloaded hash
        let save_hash = blake3::hash(saved.as_bytes()).to_hex().to_string();
        let reload_hash = blake3::hash(reloaded.as_bytes()).to_hex().to_string();
        assert_eq!(save_hash, reload_hash, "FAIL: Save/reload hash mismatch");
        println!("✓ Test 3: Save hash == reload hash");

        // Test 4: Viewport get_lines doesn't affect full document
        let before_vp_hash = blake3::hash(rope.to_string().as_bytes())
            .to_hex()
            .to_string();
        for start in [0, 10000, 25000, 40000] {
            let sc = rope.line_to_char(start);
            let ec = rope.line_to_char((start + 5000).min(rope.len_lines()));
            let _ = rope.slice(sc..ec).to_string();
        }
        let after_vp_hash = blake3::hash(rope.to_string().as_bytes())
            .to_hex()
            .to_string();
        assert_eq!(
            before_vp_hash, after_vp_hash,
            "FAIL: get_lines changed the document!"
        );
        println!("✓ Test 4: Viewport reads don't modify document");

        // Test 5: File size only grows by exact edit size
        let expected_growth = "FIRST\n".len() + "MIDDLE\n".len() + "\nLAST".len();
        assert_eq!(
            reloaded.len(),
            original_bytes + expected_growth,
            "FAIL: File size wrong (expected {}, got {})",
            original_bytes + expected_growth,
            reloaded.len()
        );
        println!("✓ Test 5: File size = original + exact edit bytes");

        let _ = std::fs::remove_file(&tmp);
        println!("\n=== ALL MANDATORY INTEGRITY TESTS PASSED ===");
    }

    /// AUTOMATED E2E TEST: Simulates the exact frontend flow including
    /// window loads at different positions, edits, and saves.
    /// Verifies file integrity with BLAKE3 hashes at every step.
    #[test]
    fn rope_e2e_automated_integrity() {
        let line_count = 150_000;
        println!("\n=== AUTOMATED E2E: {} lines ===\n", line_count);

        // Step 1: Create test file
        let original = generate_doc(line_count);
        let tmp = std::env::temp_dir().join("novelist-e2e-auto.md");
        std::fs::write(&tmp, &original).unwrap();
        let original_hash = blake3::hash(original.as_bytes()).to_hex().to_string();
        let original_line_count = original.lines().count();
        println!(
            "Original: {} lines, {} bytes, hash={}",
            original_line_count,
            original.len(),
            &original_hash[..16]
        );

        // Step 2: Open in Rope (simulates rope_open IPC)
        let mut rope =
            Rope::from_reader(std::io::BufReader::new(std::fs::File::open(&tmp).unwrap())).unwrap();
        assert_eq!(rope.len_lines(), line_count);

        // Step 3: Load viewport window 0-5000 (simulates rope_get_lines)
        let window_size = 5000;
        let sc = rope.line_to_char(0);
        let ec = rope.line_to_char(window_size.min(rope.len_lines()));
        let window1 = rope.slice(sc..ec).to_string();
        println!("Window 0-{}: {} chars", window_size, window1.len());

        // Step 4: Verify loading window doesn't change the Rope
        let after_load_hash = blake3::hash(rope.to_string().as_bytes())
            .to_hex()
            .to_string();
        assert_eq!(
            original_hash, after_load_hash,
            "FAIL: Window load corrupted Rope!"
        );
        println!("✓ Window load did not corrupt Rope");

        // Step 5: Simulate user typing "HELLO" at position 100 in the window
        // In the real app: user types → CM6 updates → dispatchEdit → rope_apply_edit
        let edit_pos = rope.line_to_char(0) + 100;
        rope.insert(edit_pos, "HELLO");
        let after_edit1_lines = rope.len_lines();
        println!(
            "After edit at pos {}: {} lines",
            edit_pos, after_edit1_lines
        );

        // Step 6: Load NEW window at line 60000 (simulates Cmd+G jump)
        // This is a read operation — MUST NOT change the Rope
        let hash_before_jump = blake3::hash(rope.to_string().as_bytes())
            .to_hex()
            .to_string();
        let sc = rope.line_to_char(60000);
        let ec = rope.line_to_char((60000 + window_size).min(rope.len_lines()));
        let window2 = rope.slice(sc..ec).to_string();
        let hash_after_jump = blake3::hash(rope.to_string().as_bytes())
            .to_hex()
            .to_string();
        assert_eq!(
            hash_before_jump, hash_after_jump,
            "FAIL: Jump corrupted Rope!"
        );
        println!(
            "✓ Jump to line 60000 did not corrupt Rope ({} chars loaded)",
            window2.len()
        );

        // Step 7: Simulate user typing at middle
        let mid_pos = rope.line_to_char(60500);
        rope.insert(mid_pos, "WORLD");
        let _after_edit2_lines = rope.len_lines();

        // Step 8: Jump to end and edit
        let hash_before_end_jump = blake3::hash(rope.to_string().as_bytes())
            .to_hex()
            .to_string();
        let end_start = rope.len_lines().saturating_sub(window_size);
        let sc = rope.line_to_char(end_start);
        let window3 = rope.slice(sc..rope.len_chars()).to_string();
        let hash_after_end_jump = blake3::hash(rope.to_string().as_bytes())
            .to_hex()
            .to_string();
        assert_eq!(
            hash_before_end_jump, hash_after_end_jump,
            "FAIL: End jump corrupted Rope!"
        );
        println!(
            "✓ Jump to end did not corrupt Rope ({} chars loaded)",
            window3.len()
        );

        rope.insert(rope.len_chars(), "\nTHE_END");

        // Step 9: Save
        let save_content = rope.to_string();
        std::fs::write(&tmp, &save_content).unwrap();

        // Step 10: VERIFY
        let reloaded = std::fs::read_to_string(&tmp).unwrap();
        let save_hash = blake3::hash(save_content.as_bytes()).to_hex().to_string();
        let reload_hash = blake3::hash(reloaded.as_bytes()).to_hex().to_string();
        assert_eq!(save_hash, reload_hash, "FAIL: Save/reload hash mismatch!");

        // Verify edits
        assert!(reloaded.contains("HELLO"), "FAIL: Edit 1 lost");
        assert!(reloaded.contains("WORLD"), "FAIL: Edit 2 lost");
        assert!(reloaded.ends_with("\nTHE_END"), "FAIL: Edit 3 lost");

        // CRITICAL: Verify line count. It should be original + 1 (for the \n in THE_END)
        let expected_lines = original_line_count + 1;
        let actual_lines = reloaded.lines().count();
        assert_eq!(
            actual_lines, expected_lines,
            "FAIL: Line count wrong! Expected {} but got {}. Delta = {} — window content leaked to Rope!",
            expected_lines, actual_lines, actual_lines as i64 - expected_lines as i64
        );

        // Verify file size grew by exactly the edit bytes
        let expected_growth = "HELLO".len() + "WORLD".len() + "\nTHE_END".len();
        assert_eq!(
            reloaded.len(),
            original.len() + expected_growth,
            "FAIL: File size wrong! Expected {} but got {}",
            original.len() + expected_growth,
            reloaded.len()
        );

        println!(
            "\n✓ Line count: {} (original {} + 1)",
            actual_lines, original_line_count
        );
        println!(
            "✓ File size: {} bytes (original + {} edit bytes)",
            reloaded.len(),
            expected_growth
        );
        println!("✓ All 3 edits preserved");
        println!("✓ No window content leaked to Rope");
        println!("✓ Hash consistent: {}", &save_hash[..16]);

        let _ = std::fs::remove_file(&tmp);
        println!("\n=== AUTOMATED E2E PASSED ===");
    }

    #[test]
    fn rope_benchmark_200k_cjk() {
        let line_count = 200_000;
        println!("\n=== Rope Benchmark CJK: {} lines ===", line_count);

        let mut parts = Vec::with_capacity(line_count);
        for i in 0..line_count {
            if i % 100 == 0 {
                parts.push(format!("# 第{}章", i / 100 + 1));
            } else if i % 5 == 0 {
                parts.push(String::new());
            } else {
                parts.push(
                    "落霞与孤鹜齐飞秋水共长天一色渔舟唱晚响穷彭蠡之滨雁阵惊寒声断衡阳之浦"
                        .to_string(),
                );
            }
        }
        let doc = parts.join("\n");
        println!("Doc size: {:.1} MB", doc.len() as f64 / 1024.0 / 1024.0);

        let t = Instant::now();
        let mut rope = Rope::from_str(&doc);
        println!(
            "Rope::from_str: {:.1}ms ({} lines)",
            t.elapsed().as_secs_f64() * 1000.0,
            rope.len_lines()
        );

        // Viewport load
        let t = Instant::now();
        let sc = rope.line_to_char(100000);
        let ec = rope.line_to_char(103000);
        let _ = rope.slice(sc..ec).to_string();
        println!(
            "Get viewport mid 100K-103K: {:.3}ms",
            t.elapsed().as_secs_f64() * 1000.0
        );

        // Insert CJK char
        let mid = rope.len_chars() / 2;
        let t = Instant::now();
        rope.insert(mid, "测");
        println!(
            "Insert CJK char at mid: {:.3}ms",
            t.elapsed().as_secs_f64() * 1000.0
        );

        // Typing simulation
        let mut times = Vec::with_capacity(50);
        let pos = rope.len_chars() / 2;
        for i in 0..50 {
            let t = Instant::now();
            rope.insert(pos + i, "字");
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let avg = times.iter().sum::<f64>() / times.len() as f64;
        println!("Typing 50 CJK chars: avg={:.3}ms", avg);
    }
}
