import pytest

from om_bridge.types import PickTask, TaskStatus, TERMINAL_STATUSES


def test_from_api_maps_the_module_envelope():
    task = PickTask.from_api(
        {
            "id": "t-1",
            "cellId": "c-1",
            "instruction": "pick up the can",
            "targetLabel": "can",
            "dropPreset": "shelf_cans",
            "maxAttempts": 3,
            "metadata": {"attempt": 1},
        }
    )
    assert (task.id, task.cell_id, task.target_label) == ("t-1", "c-1", "can")
    assert task.drop_preset == "shelf_cans"
    assert task.max_attempts == 3


def test_from_api_defaults_optional_fields():
    task = PickTask.from_api({"id": "t", "cellId": "c", "instruction": "pick up the can"})
    assert task.target_label == "can"
    assert task.drop_preset is None
    assert task.max_attempts == 1


@pytest.mark.parametrize("payload", [{}, {"id": "t"}, {"id": "t", "cellId": "c"}])
def test_from_api_rejects_incomplete_payloads(payload):
    with pytest.raises(ValueError, match="missing"):
        PickTask.from_api(payload)


def test_terminal_statuses_are_the_closed_ones():
    assert set(TERMINAL_STATUSES) == {TaskStatus.SUCCEEDED, TaskStatus.FAILED, TaskStatus.ABORTED}
