use anyhow::{Context, Result, bail};
use clap::{Parser, ValueEnum};
use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use walkdir::WalkDir;

#[derive(Clone, Copy, Debug, ValueEnum)]
enum ProjectKind {
    Auto,
    Rust,
    Js,
    Ts,
    React,
    Vite,
}

#[derive(Debug, Parser)]
#[command(name = "forge-obfuscator")]
#[command(about = "Build Rust and web projects, then emit protected artifacts")]
struct Cli {
    #[arg(default_value = ".")]
    input: PathBuf,

    #[arg(short, long, default_value = "obfuscated-dist")]
    output: PathBuf,

    #[arg(short = 't', long, value_enum, default_value = "auto")]
    project_type: ProjectKind,

    #[arg(long)]
    no_build: bool,

    #[arg(long)]
    keep_output: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let input = cli
        .input
        .canonicalize()
        .with_context(|| format!("project directory not found: {}", cli.input.display()))?;

    if !input.is_dir() {
        bail!("input is not a directory: {}", input.display());
    }

    let output = if cli.output.is_absolute() {
        cli.output
    } else {
        input.join(cli.output)
    };

    if output == input {
        bail!("output directory must differ from input directory");
    }
    if output.exists() && !cli.keep_output {
        fs::remove_dir_all(&output)?;
    }
    fs::create_dir_all(&output)?;

    let kind = detect_kind(&input, cli.project_type)?;
    println!("Project: {}", input.display());
    println!("Type: {kind:?}");
    println!("Output: {}", output.display());

    match kind {
        ProjectKind::Rust => process_rust(&input, &output, !cli.no_build)?,
        ProjectKind::Js | ProjectKind::Ts | ProjectKind::React | ProjectKind::Vite => {
            process_web(&input, &output, !cli.no_build)?
        }
        ProjectKind::Auto => unreachable!(),
    }

    println!("Obfuscation completed successfully.");
    Ok(())
}

fn detect_kind(input: &Path, requested: ProjectKind) -> Result<ProjectKind> {
    if !matches!(requested, ProjectKind::Auto) {
        return Ok(requested);
    }
    if input.join("Cargo.toml").exists() {
        return Ok(ProjectKind::Rust);
    }

    let package = input.join("package.json");
    if package.exists() {
        let text = fs::read_to_string(package)?;
        if text.contains("\"vite\"") {
            return Ok(ProjectKind::Vite);
        }
        if text.contains("\"react\"") || text.contains("\"react-dom\"") {
            return Ok(ProjectKind::React);
        }
        if input.join("tsconfig.json").exists() {
            return Ok(ProjectKind::Ts);
        }
        return Ok(ProjectKind::Js);
    }

    bail!("project type could not be detected; use --project-type")
}

fn process_rust(input: &Path, output: &Path, build: bool) -> Result<()> {
    if build {
        run(input, "cargo", &["build", "--release"])?;
    }

    copy_sources(input, &output.join("src"), is_rust_source)?;
    copy_if_exists(&input.join("Cargo.toml"), &output.join("Cargo.toml"))?;
    copy_if_exists(&input.join("Cargo.lock"), &output.join("Cargo.lock"))?;

    let release = input.join("target").join("release");
    if build && release.exists() {
        copy_tree(&release, &output.join("build"), |path| {
            !path
                .components()
                .any(|part| part.as_os_str() == OsStr::new("deps"))
                && !matches!(
                    path.extension().and_then(OsStr::to_str),
                    Some("d" | "rlib" | "rmeta" | "pdb")
                )
        })?;
    }
    Ok(())
}

fn process_web(input: &Path, output: &Path, build: bool) -> Result<()> {
    if build {
        run_npm(input, &["run", "build"])?;
    }

    copy_sources(input, &output.join("source"), is_web_source)?;
    for name in [
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "vite.config.js",
        "vite.config.ts",
    ] {
        copy_if_exists(&input.join(name), &output.join(name))?;
    }

    if build {
        for directory in ["dist", "build"] {
            let candidate = input.join(directory);
            if candidate.exists() {
                let build_output = output.join("build");
                copy_tree(&candidate, &build_output, |_| true)?;
                obfuscate_javascript(&build_output)?;
                break;
            }
        }
    }
    Ok(())
}

fn copy_sources(input: &Path, output: &Path, include: fn(&Path) -> bool) -> Result<()> {
    for entry in WalkDir::new(input)
        .into_iter()
        .filter_entry(|entry| !ignored(entry.path()))
    {
        let entry = entry?;
        if !entry.file_type().is_file() || !include(entry.path()) {
            continue;
        }

        let destination = output.join(entry.path().strip_prefix(input)?);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let source = fs::read_to_string(entry.path())?;
        fs::write(destination, remove_standalone_comments(&source))?;
    }
    Ok(())
}

fn remove_standalone_comments(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    let mut previous_blank = false;

    for line in source.lines() {
        let trimmed = line.trim();
        let remove =
            trimmed.starts_with("//") && !trimmed.starts_with("///") && !trimmed.starts_with("//!");
        let line = if remove { "" } else { line.trim_end() };
        let blank = line.trim().is_empty();
        if blank && previous_blank {
            continue;
        }
        output.push_str(line);
        output.push('\n');
        previous_blank = blank;
    }
    output
}

fn obfuscate_javascript(build: &Path) -> Result<()> {
    let files = WalkDir::new(build)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry.file_type().is_file()
                && matches!(
                    entry.path().extension().and_then(OsStr::to_str),
                    Some("js" | "mjs" | "cjs")
                )
        })
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();

    println!("Obfuscating {} JavaScript file(s)...", files.len());
    for file in files {
        let temporary = file.with_extension("obfuscated.tmp.js");
        let source = file.to_string_lossy().into_owned();
        let destination = temporary.to_string_lossy().into_owned();
        run_npx(
            build,
            &[
                "--yes",
                "javascript-obfuscator",
                &source,
                "--output",
                &destination,
                "--compact",
                "true",
                "--control-flow-flattening",
                "true",
                "--identifier-names-generator",
                "hexadecimal",
                "--rename-globals",
                "false",
                "--self-defending",
                "true",
                "--string-array",
                "true",
                "--string-array-encoding",
                "base64",
            ],
        )?;
        fs::rename(temporary, file)?;
    }
    Ok(())
}

fn run_npm(directory: &Path, args: &[&str]) -> Result<()> {
    let executable = if cfg!(windows) { "npm.cmd" } else { "npm" };
    run(directory, executable, args)
}

fn run_npx(directory: &Path, args: &[&str]) -> Result<()> {
    let executable = if cfg!(windows) { "npx.cmd" } else { "npx" };
    run(directory, executable, args)
}

fn run(directory: &Path, executable: &str, args: &[&str]) -> Result<()> {
    println!("> {executable} {}", args.join(" "));
    let status = Command::new(executable)
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .with_context(|| format!("failed to start {executable}"))?;

    if !status.success() {
        bail!("command failed with status {status}: {executable}");
    }
    Ok(())
}

fn copy_if_exists(source: &Path, destination: &Path) -> Result<()> {
    if source.exists() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
    }
    Ok(())
}

fn copy_tree<F>(source: &Path, destination: &Path, include: F) -> Result<()>
where
    F: Fn(&Path) -> bool,
{
    for entry in WalkDir::new(source) {
        let entry = entry?;
        let target = destination.join(entry.path().strip_prefix(source)?);
        if entry.file_type().is_dir() {
            fs::create_dir_all(target)?;
        } else if include(entry.path()) {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn ignored(path: &Path) -> bool {
    path.components().any(|part| {
        matches!(
            part.as_os_str().to_str(),
            Some("target" | "node_modules" | "dist" | "build" | ".git" | "obfuscated-dist")
        )
    })
}

fn is_rust_source(path: &Path) -> bool {
    path.extension().and_then(OsStr::to_str) == Some("rs")
}

fn is_web_source(path: &Path) -> bool {
    matches!(
        path.extension().and_then(OsStr::to_str),
        Some("js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "css" | "html")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_standalone_comments() {
        let output = remove_standalone_comments("// remove\nconst x = 1;\n");
        assert!(!output.contains("remove"));
        assert!(output.contains("const x = 1;"));
    }

    #[test]
    fn preserves_documentation_comments() {
        let output = remove_standalone_comments("/// Documentation\nfn main() {}\n");
        assert!(output.contains("/// Documentation"));
    }
}
