from jupyterlab_workshop.overrides import NEWS_SETTING, NOTIFICATION_PLUGIN, quiet_news


def test_quiet_news_turns_the_prompt_off_without_touching_the_rest() -> None:
    given = {"@jupyterlab/apputils-extension:themes": {"theme": "JupyterLab Dark"}}

    result = quiet_news(given)

    assert result == {
        **given,
        NOTIFICATION_PLUGIN: {NEWS_SETTING: "false"},
    }
    assert NOTIFICATION_PLUGIN not in given


def test_quiet_news_keeps_an_answer_already_given() -> None:
    given = {NOTIFICATION_PLUGIN: {NEWS_SETTING: "true", "checkForUpdates": False}}

    assert quiet_news(given) == given

    # Other settings of the plugin stay when the prompt is unanswered.
    partial = {NOTIFICATION_PLUGIN: {"doNotDisturbMode": True}}

    assert quiet_news(partial) == {
        NOTIFICATION_PLUGIN: {"doNotDisturbMode": True, NEWS_SETTING: "false"}
    }
