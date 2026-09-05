import json


async def test_platform_endpoint_reports_the_server_environment(jp_fetch, jp_root_dir):
    response = await jp_fetch("educates-workshop", "platform")

    assert response.code == 200

    payload = json.loads(response.body)

    assert set(payload) == {"os", "shell", "home", "user", "path_sep", "root_dir"}
    assert payload["os"] in {"linux", "macos", "windows"}
    assert payload["root_dir"] == str(jp_root_dir)
