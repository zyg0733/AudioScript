use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug)]
struct Args {
    public_key_file: Option<PathBuf>,
    signature: PathBuf,
    artifact: PathBuf,
    version: Option<Version>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    artifact: String,
    version: Option<String>,
    signed_version: Option<String>,
    sha256: String,
}

fn parse_version(value: &str) -> Result<Version, String> {
    Version::parse(value.trim_start_matches('v')).map_err(|_| "更新版本格式无效".into())
}

fn parse_args(values: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut values = values.into_iter();
    let mut public_key_file = None;
    let mut signature = None;
    let mut artifact = None;
    let mut version = None;
    let mut allow_unversioned = false;
    while let Some(flag) = values.next() {
        if flag == "--allow-unversioned" {
            if allow_unversioned {
                return Err("参数不可重复".into());
            }
            allow_unversioned = true;
            continue;
        }
        if !matches!(
            flag.as_str(),
            "--public-key-file" | "--signature" | "--artifact" | "--version"
        ) {
            return Err("存在未知验签参数".into());
        }
        let value = values.next().ok_or("验签参数缺少值")?;
        match flag.as_str() {
            "--public-key-file" if public_key_file.is_none() => {
                public_key_file = Some(PathBuf::from(value));
            }
            "--signature" if signature.is_none() => signature = Some(PathBuf::from(value)),
            "--artifact" if artifact.is_none() => artifact = Some(PathBuf::from(value)),
            "--version" if version.is_none() => version = Some(parse_version(&value)?),
            _ => return Err("参数不可重复".into()),
        }
    }
    if allow_unversioned == version.is_some() {
        return Err(
            "生产验签必须指定 --version；仅无版本预检样本可单独使用 --allow-unversioned".into(),
        );
    }
    Ok(Args {
        public_key_file,
        signature: signature.ok_or("缺少 --signature")?,
        artifact: artifact.ok_or("缺少 --artifact")?,
        version,
    })
}

fn decode_envelope(value: &str, label: &str) -> Result<String, String> {
    let decoded = STANDARD
        .decode(value.trim())
        .map_err(|_| format!("{label}的 base64 格式无效"))?;
    String::from_utf8(decoded).map_err(|_| format!("{label}编码无效"))
}

fn verify(
    artifact: &[u8],
    encoded_signature: &str,
    encoded_public_key: &str,
    expected_version: Option<&Version>,
) -> Result<Option<Version>, String> {
    let key_text = decode_envelope(encoded_public_key, "更新公钥")?;
    let public_key = PublicKey::decode(&key_text).map_err(|_| "更新公钥格式无效")?;
    let signature_text = decode_envelope(encoded_signature, "更新签名")?;
    let signature = Signature::decode(&signature_text).map_err(|_| "更新签名格式无效")?;
    // 必须先验证全局签名，才能读取 trusted comment 中绑定的版本。
    public_key
        .verify(artifact, &signature, true)
        .map_err(|_| "更新包或签名校验失败")?;
    let mut versions = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|field| field.strip_prefix("version:"));
    let signed_version = versions.next().map(parse_version).transpose()?;
    if versions.next().is_some() {
        return Err("更新签名包含多个版本字段".into());
    }
    if let Some(expected_version) = expected_version {
        let actual = signed_version.as_ref().ok_or("更新签名未绑定版本")?;
        if actual != expected_version {
            return Err("更新签名版本与清单版本不一致".into());
        }
    }
    Ok(signed_version)
}

fn read_text(path: &Path, label: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|_| format!("无法读取{label}文件"))
}

fn run(args: Args) -> Result<Report, String> {
    let public_key_env = std::env::var("TAURI_UPDATER_PUBLIC_KEY").unwrap_or_default();
    let public_key = if let Some(path) = args.public_key_file {
        if !public_key_env.trim().is_empty() {
            return Err("公钥文件与 TAURI_UPDATER_PUBLIC_KEY 不可同时指定".into());
        }
        read_text(&path, "更新公钥")?
    } else if !public_key_env.trim().is_empty() {
        public_key_env
    } else {
        return Err("未配置本项目更新公钥".into());
    };
    let signature = read_text(&args.signature, "更新签名")?;
    let artifact = std::fs::read(&args.artifact).map_err(|_| "无法读取更新包文件")?;
    let signed_version = verify(&artifact, &signature, &public_key, args.version.as_ref())?;
    Ok(Report {
        artifact: args
            .artifact
            .file_name()
            .ok_or("更新包文件名无效")?
            .to_string_lossy()
            .into_owned(),
        version: args.version.map(|v| v.to_string()),
        signed_version: signed_version.map(|v| v.to_string()),
        sha256: format!("{:x}", Sha256::digest(&artifact)),
    })
}

fn main() {
    let result = parse_args(std::env::args().skip(1)).and_then(run);
    match result {
        Ok(report) => println!("{}", serde_json::to_string(&report).unwrap()),
        Err(error) => {
            eprintln!("更新验签失败：{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 公开测试向量：tauri-plugin-updater 2.14.0 (MIT / Apache-2.0)，签名内容为 test。
    const PUBLIC_KEY: &str = "untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe";
    const SIGNATURE: &str = "untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==";
    // 公开测试向量：minisign-verify 0.3.0 (MIT)，签名内容为 test，无绑定版本。
    const OTHER_PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const UNVERSIONED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";

    fn check(
        data: &[u8],
        signature: &str,
        key: &str,
        version: Option<&str>,
    ) -> Result<Option<Version>, String> {
        let version = version.map(parse_version).transpose()?;
        verify(
            data,
            &STANDARD.encode(signature),
            &STANDARD.encode(key),
            version.as_ref(),
        )
    }

    #[test]
    fn accepts_a_real_version_bound_signature() {
        assert_eq!(
            check(b"test", SIGNATURE, PUBLIC_KEY, Some("v2.0.0")),
            Ok(Some(Version::new(2, 0, 0)))
        );
    }

    #[test]
    fn rejects_modified_package_bytes() {
        assert!(check(b"Test", SIGNATURE, PUBLIC_KEY, Some("2.0.0")).is_err());
    }

    #[test]
    fn rejects_a_different_valid_public_key() {
        assert!(check(b"test", SIGNATURE, OTHER_PUBLIC_KEY, Some("2.0.0")).is_err());
    }

    #[test]
    fn verifies_the_global_signature_before_using_trusted_comment() {
        let modified_comment = SIGNATURE.replace("file:payload", "file:other");
        assert!(check(b"test", &modified_comment, PUBLIC_KEY, Some("2.0.0")).is_err());
    }

    #[test]
    fn rejects_a_manifest_version_different_from_the_signed_version() {
        assert_eq!(
            check(b"test", SIGNATURE, PUBLIC_KEY, Some("2.0.1")),
            Err("更新签名版本与清单版本不一致".into())
        );
    }

    #[test]
    fn accepts_unversioned_signatures_only_for_explicit_challenge_verification() {
        assert_eq!(
            check(b"test", UNVERSIONED_SIGNATURE, OTHER_PUBLIC_KEY, None),
            Ok(None)
        );
        assert_eq!(
            check(
                b"test",
                UNVERSIONED_SIGNATURE,
                OTHER_PUBLIC_KEY,
                Some("2.0.0")
            ),
            Err("更新签名未绑定版本".into())
        );
    }

    #[test]
    fn reports_malformed_public_input_without_echoing_it() {
        let marker = "INVALID_PUBLIC_INPUT";
        assert!(!verify(b"test", marker, marker, None)
            .unwrap_err()
            .contains(marker));
    }

    fn arguments(args: &[&str]) -> Result<Args, String> {
        parse_args(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn requires_a_version_unless_challenge_mode_is_explicit() {
        let common = ["--artifact", "app", "--signature", "app.sig"];
        assert!(arguments(&common).is_err());
        assert!(arguments(&[&common[..], &["--version", "2.0.0"]].concat()).is_ok());
        assert!(arguments(&[&common[..], &["--allow-unversioned"]].concat()).is_ok());
        assert!(
            arguments(&[&common[..], &["--version", "2.0.0", "--allow-unversioned"]].concat())
                .is_err()
        );
    }

    #[test]
    fn rejects_unknown_duplicate_or_incomplete_arguments() {
        for args in [
            vec!["--artifact"],
            vec!["--unknown", "value"],
            vec!["--artifact", "app", "--artifact", "other"],
            vec!["--allow-unversioned", "--allow-unversioned"],
            vec!["--version", "invalid"],
        ] {
            assert!(arguments(&args).is_err());
        }
    }
}
