from educates_jupyterlab_workshop.platform import PlatformInfo, detect_platform


def detect(**overrides: object) -> PlatformInfo:
    inputs: dict[str, object] = {
        "system": "Linux",
        "shell_command": None,
        "environ": {},
        "home": "/home/learner",
        "user": "learner",
        "root_dir": "/home/learner/work",
    }
    inputs.update(overrides)

    return detect_platform(**inputs)  # type: ignore[arg-type]


def test_linux_defaults_to_sh_without_shell_hints() -> None:
    info = detect()

    assert info.os == "linux"
    assert info.shell == "sh"
    assert info.path_sep == "/"
    assert info.home == "/home/learner"
    assert info.user == "learner"
    assert info.root_dir == "/home/learner/work"


def test_shell_environment_variable_is_used() -> None:
    assert detect(environ={"SHELL": "/bin/zsh"}).shell == "zsh"
    assert detect(environ={"SHELL": "/usr/local/bin/fish"}).shell == "fish"


def test_configured_shell_command_wins_over_environment() -> None:
    info = detect(shell_command=["/bin/bash", "-l"], environ={"SHELL": "/bin/zsh"})

    assert info.shell == "bash"


def test_unknown_shell_falls_back_to_default() -> None:
    assert detect(environ={"SHELL": "/opt/odd/xonsh"}).shell == "sh"


def test_macos_is_reported_as_macos() -> None:
    assert detect(system="Darwin").os == "macos"


def test_windows_defaults_to_powershell_and_backslash() -> None:
    info = detect(system="Windows", environ={"SHELL": "/bin/bash"})

    assert info.os == "windows"
    assert info.shell == "powershell"
    assert info.path_sep == "\\"


def test_windows_shell_command_names_are_normalised() -> None:
    assert detect(system="Windows", shell_command=["pwsh.exe"]).shell == "powershell"
    assert detect(system="Windows", shell_command=["cmd.exe"]).shell == "cmd"
    windows_bash = ["C:\\Git\\bin\\bash.exe"]

    assert detect(system="Windows", shell_command=windows_bash).shell == "bash"


def test_to_dict_round_trips_all_fields() -> None:
    info = detect()

    assert info.to_dict() == {
        "os": "linux",
        "shell": "sh",
        "home": "/home/learner",
        "user": "learner",
        "path_sep": "/",
        "root_dir": "/home/learner/work",
    }
