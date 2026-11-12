use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, io::Read, path::Path};
use tectonic_bridge_core::DriverHooks;
use tectonic_io_base::OpenResult;
use tectonic_status_base::StatusBackend;

fn read(
    hooks: &mut dyn DriverHooks,
    status: &mut dyn StatusBackend,
    name: &str,
) -> Option<Vec<u8>> {
    let mut input = match hooks.io().input_open_name(name, status) {
        OpenResult::Ok(input) => input,
        _ => return None,
    };
    let mut data = Vec::new();
    let result = input.read_to_end(&mut data);
    let (name, digest) = input.into_name_digest();
    hooks.event_input_closed(name, digest, status);
    result.ok()?;
    Some(data)
}

fn field(hash: &mut Sha256, data: &[u8]) {
    hash.update((data.len() as u64).to_le_bytes());
    hash.update(data);
}

fn argument<'a>(line: &'a str, command: &str) -> Option<&'a str> {
    line.strip_prefix(command)?
        .strip_prefix('{')?
        .strip_suffix('}')
}

pub(super) fn fingerprint(
    main_aux: &str,
    hooks: &mut dyn DriverHooks,
    status: &mut dyn StatusBackend,
) -> Option<String> {
    let mut hash = Sha256::new();
    field(&mut hash, b"texfolia-bibtex-v1");
    let mut pending = BTreeSet::from([main_aux.to_owned()]);
    let mut visited = BTreeSet::new();
    let mut dependencies = BTreeSet::new();
    let mut bibliographies = BTreeSet::new();
    while let Some(name) = pending.pop_first() {
        if !visited.insert(name.clone()) {
            continue;
        }
        let data = read(hooks, status, &name)?;
        let text = std::str::from_utf8(&data).ok()?;
        field(&mut hash, name.as_bytes());
        for line in text.lines().map(str::trim) {
            if let Some(child) = argument(line, "\\@input") {
                pending.insert(child.to_owned());
                field(&mut hash, line.as_bytes());
            } else if line.contains("\\citation") {
                argument(line, "\\citation")?;
                field(&mut hash, line.as_bytes());
            } else if line.contains("\\bibdata") {
                for database in argument(line, "\\bibdata")?.split(',') {
                    let database = database.trim();
                    if database.is_empty() {
                        return None;
                    }
                    dependencies.insert(if database.ends_with(".bib") {
                        database.to_owned()
                    } else {
                        format!("{database}.bib")
                    });
                }
                bibliographies.insert(Path::new(&name).with_extension("bbl"));
                field(&mut hash, line.as_bytes());
            } else if line.contains("\\bibstyle") {
                let style = argument(line, "\\bibstyle")?.trim();
                if style.is_empty() {
                    return None;
                }
                dependencies.insert(if style.ends_with(".bst") {
                    style.to_owned()
                } else {
                    format!("{style}.bst")
                });
                field(&mut hash, line.as_bytes());
            } else if line.contains("\\@input") {
                return None;
            }
        }
    }
    if bibliographies.is_empty() {
        return None;
    }
    for bibliography in bibliographies {
        let name = bibliography.to_str()?;
        let data = read(hooks, status, name)?;
        if data.is_empty() {
            return None;
        }
        field(&mut hash, name.as_bytes());
        field(&mut hash, &data);
    }
    for dependency in dependencies {
        field(&mut hash, dependency.as_bytes());
        field(&mut hash, &read(hooks, status, &dependency)?);
    }
    Some(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{io::memory::MemoryIo, status::NoopStatusBackend};
    use tectonic_io_base::IoProvider;

    struct Inputs(MemoryIo);

    impl DriverHooks for Inputs {
        fn io(&mut self) -> &mut dyn IoProvider {
            &mut self.0
        }
    }

    fn inputs() -> Inputs {
        let mut inputs = Inputs(MemoryIo::new(false));
        for (name, data) in [
            (
                "main.aux",
                "\\relax\n\\citation{knuth}\n\\bibdata{references}\n\\bibstyle{plain}\n",
            ),
            ("main.bbl", "bibliography output"),
            ("references.bib", "bibliography source"),
            ("plain.bst", "bibliography style"),
        ] {
            inputs.0.create_entry(name, data.as_bytes().to_vec());
        }
        inputs
    }

    fn key(inputs: &mut Inputs) -> Option<String> {
        fingerprint("main.aux", inputs, &mut NoopStatusBackend::default())
    }

    #[test]
    fn bibliography_inputs_invalidate_cache() {
        let original = key(&mut inputs()).unwrap();
        for (name, data) in [
            ("references.bib", "changed bibliography"),
            ("plain.bst", "changed style"),
            ("main.bbl", "changed bibliography output"),
            (
                "main.aux",
                "\\citation{lamport}\n\\bibdata{references}\n\\bibstyle{plain}\n",
            ),
            (
                "main.aux",
                "\\citation{*}\n\\bibdata{references}\n\\bibstyle{plain}\n",
            ),
        ] {
            let mut inputs = inputs();
            inputs.0.create_entry(name, data.as_bytes().to_vec());
            assert_ne!(key(&mut inputs), Some(original.clone()), "{name}");
        }
    }

    #[test]
    fn reference_changes_do_not_invalidate_bibliography() {
        let mut inputs = inputs();
        let original = key(&mut inputs).unwrap();
        inputs.0.create_entry("main.aux", b"\\citation{knuth}\n\\bibdata{references}\n\\bibstyle{plain}\n\\newlabel{intro}{{1}{2}}\n".to_vec());
        assert_eq!(key(&mut inputs), Some(original));
    }

    #[test]
    fn missing_or_unsupported_inputs_fail_closed() {
        for name in ["main.aux", "main.bbl", "references.bib", "plain.bst"] {
            let mut inputs = inputs();
            inputs.0.files.borrow_mut().remove(name);
            assert!(key(&mut inputs).is_none(), "{name}");
        }
        let mut inputs = inputs();
        inputs.0.create_entry(
            "main.aux",
            b"\\bibdata{references}\n\\bibstyle {plain}".to_vec(),
        );
        assert!(key(&mut inputs).is_none());
    }

    #[test]
    fn follows_child_auxiliaries_and_handles_cycles() {
        let mut inputs = inputs();
        inputs.0.create_entry(
            "main.aux",
            b"\\@input{chapter.aux}\n\\bibdata{references}\n\\bibstyle{plain}".to_vec(),
        );
        inputs.0.create_entry(
            "chapter.aux",
            b"\\citation{knuth}\n\\@input{main.aux}".to_vec(),
        );
        let original = key(&mut inputs).unwrap();
        inputs.0.create_entry(
            "chapter.aux",
            b"\\citation{lamport}\n\\@input{main.aux}".to_vec(),
        );
        assert_ne!(key(&mut inputs), Some(original));
    }
}
