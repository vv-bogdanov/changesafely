import json


def decode_event(raw):
    data = json.loads(raw)
    if data.get("version") != 1:
        raise ValueError("unsupported event version")
    return {
        "id": data["id"],
        "amount_cents": str(data["amount_cents"]),
        "sequence": data["sequence"],
    }


def replay(raw_events):
    decoded = [decode_event(raw) for raw in raw_events]
    return sorted(decoded, key=lambda event: event["sequence"])
