import json

from events import decode_event, replay


def event(event_id="order-1", sequence=1):
    return json.dumps(
        {
            "version": 1,
            "type": "order.created",
            "id": event_id,
            "amount_cents": "1250",
            "sequence": sequence,
        }
    )


def test_decodes_the_existing_v1_contract():
    assert decode_event(event()) == {
        "id": "order-1",
        "amount_cents": "1250",
        "sequence": 1,
    }


def test_replays_existing_events_in_order():
    assert [item["id"] for item in replay([event("order-1", 1), event("order-2", 2)])] == [
        "order-1",
        "order-2",
    ]
