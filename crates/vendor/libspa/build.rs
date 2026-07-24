fn version_at_least(version: &str, minimum: (u32, u32, u32)) -> bool {
    let mut parts = version.split('.').map(|part| {
        part.bytes()
            .take_while(u8::is_ascii_digit)
            .fold(0_u32, |value, digit| value * 10 + u32::from(digit - b'0'))
    });
    let current = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    current >= minimum
}

fn main() {
    // FIXME: It would be nice to run this only when tests are run.
    println!("cargo:rerun-if-changed=tests/pod.c");

    let libs = system_deps::Config::new()
        .probe()
        .expect("Cannot find libspa");
    let libspa = libs.get_by_name("libspa").unwrap();
    println!("cargo:rustc-check-cfg=cfg(libspa_video_info_has_flags)");
    if version_at_least(&libs.get_by_name("libpipewire").unwrap().version, (0, 3, 65)) {
        println!("cargo:rustc-cfg=libspa_video_info_has_flags");
    }

    cc::Build::new()
        .file("tests/pod.c")
        .flag("-Wno-missing-field-initializers")
        .includes(&libspa.include_paths)
        .compile("pod");
}
