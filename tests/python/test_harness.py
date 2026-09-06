from jupyterlab_workshop.harness import timed_out_report


def test_timed_out_report_keeps_results_and_names_the_running_action() -> None:
    progress = {
        "results": [
            {
                "page": "p1",
                "id": "a",
                "type": "execute",
                "status": "ok",
                "message": "",
                "seconds": 1.0,
            },
            {
                "page": "p1",
                "id": "b",
                "type": "verify",
                "status": "skipped",
                "message": "",
                "seconds": 0,
            },
        ],
        "current": {"page": "p2", "id": "c", "type": "execute", "startedAt": 0},
    }

    report = timed_out_report("demo", progress, 1200.0)

    assert report["workshop"] == "demo"
    assert report["timedOut"] is True
    assert [item["id"] for item in report["results"]] == ["a", "b", "c"]
    assert report["results"][-1]["status"] == "error"
    assert report["results"][-1]["timedOut"] is True
    assert "1200s" in report["results"][-1]["message"]
    assert (report["passed"], report["failed"], report["skipped"]) == (1, 1, 1)


def test_timed_out_report_without_progress_still_fails() -> None:
    report = timed_out_report("demo", None, 60.0)

    assert report["failed"] == 1
    assert report["results"][0]["id"] == "self-test"
    assert "60s" in report["results"][0]["message"]
