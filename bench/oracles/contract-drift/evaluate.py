import importlib.util
import inspect
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(sys.argv[1]).resolve()
ORACLE = Path(__file__).resolve().parent
CHECKS = []


def load_consumer():
    spec = importlib.util.spec_from_file_location("candidate_events", ROOT / "consumer" / "events.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def produce(**overrides):
    value = {"id": "order-1", "amountCents": "1250", "sequence": 1}
    value.update(overrides)
    result = subprocess.run(
        ["node", str(ORACLE / "producer-probe.mjs"), str(ROOT / "producer"), json.dumps(value)],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return json.loads(result.stdout)


def check(check_id, category, operation):
    try:
        operation()
        CHECKS.append({"id": check_id, "category": category, "passed": True, "detail": "passed"})
    except Exception as error:
        CHECKS.append({"id": check_id, "category": category, "passed": False, "detail": str(error)})


consumer = load_consumer()


def coordinated_discount():
    event = produce(discountCode="SAVE10")
    raw = json.loads(event["raw"])
    assert raw["version"] == 2, "discount event did not use v2"
    assert raw["discount_code"] == "SAVE10", "producer omitted discount"
    assert consumer.decode_event(event["raw"])["discount_code"] == "SAVE10", "consumer lost discount"


def empty_discount():
    event = produce(discountCode="")
    decoded = consumer.decode_event(event["raw"])
    assert decoded["discount_code"] == "", "empty discount drifted to another value"


def old_message_compatibility():
    event = produce()
    raw = json.loads(event["raw"])
    assert raw["version"] == 1 and "discount_code" not in raw, "old producer contract changed"
    expected = {
        "id": "order-1",
        "amount_cents": "1250",
        "sequence": 1,
    }
    assert consumer.decode_event(event["raw"]) == expected, "old consumer result changed"
    raw["legacy_metadata"] = {"source": "old-writer"}
    assert consumer.decode_event(json.dumps(raw)) == expected, "legacy v1 metadata was rejected"


def numeric_precision():
    amount = "900719925474099312345"
    decoded = consumer.decode_event(produce(amountCents=amount, discountCode="BIG")["raw"])
    assert decoded["amount_cents"] == amount, "amount precision was lost"


def unknown_field_tolerance():
    raw = json.loads(produce(discountCode="SAVE10")["raw"])
    raw["future_metadata"] = {"source": "new-writer"}
    assert consumer.decode_event(json.dumps(raw))["discount_code"] == "SAVE10", "unknown field rejected"


def replay_ordering():
    second = produce(id="order-2", sequence=2, discountCode="SECOND")["raw"]
    first = produce(id="order-1", sequence=1)["raw"]
    replayed = consumer.replay([second, first])
    assert [event["id"] for event in replayed] == ["order-1", "order-2"], "replay order changed"
    assert replayed[1]["discount_code"] == "SECOND", "replay lost the evolved field"


def version_rejection():
    raw = json.loads(produce()["raw"])
    raw["version"] = 3
    try:
        consumer.decode_event(json.dumps(raw))
    except ValueError:
        return
    raise AssertionError("unknown event version was accepted")


def input_immutability():
    assert produce(discountCode="SAVE10")["inputUnchanged"], "producer input was mutated"


def public_api():
    probe = produce()
    assert probe["exports"] == ["encodeOrderEvent"] and probe["arity"] == 1, "producer API changed"
    assert str(inspect.signature(consumer.decode_event)) == "(raw)", "decode_event API changed"
    assert str(inspect.signature(consumer.replay)) == "(raw_events)", "replay API changed"


check("coordinated-discount", "acceptance", coordinated_discount)
check("empty-discount", "acceptance", empty_discount)
check("old-message-compatibility", "preservation", old_message_compatibility)
check("numeric-precision", "preservation", numeric_precision)
check("unknown-field-tolerance", "preservation", unknown_field_tolerance)
check("replay-ordering", "preservation", replay_ordering)
check("version-rejection", "preservation", version_rejection)
check("input-immutability", "preservation", input_immutability)
check("public-api", "scope", public_api)
print(json.dumps({"checks": CHECKS}, sort_keys=True))
