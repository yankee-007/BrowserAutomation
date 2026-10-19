"""Real plugin API acceptance against the harness's synthetic page only."""
import json
import time
from collections import Counter

from pagesense import PageSenseClient
from protocol import PageSenseError

checks = []
methods = Counter()


def passed(name):
    checks.append(name)


def error(fn, code):
    try:
        fn()
    except PageSenseError as exc:
        assert exc.code == code, (exc.code, code)
    else:
        raise AssertionError("expected " + code)


def until(fn):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            if fn():
                return
        except PageSenseError:
            pass
        time.sleep(0.15)
    raise AssertionError("condition did not become true")


with PageSenseClient() as client:
    original_call = client.call

    def measured(method, timeout=None, **params):
        methods[method] += 1
        return original_call(method, timeout=timeout, **params)

    client.call = measured
    root = client.find("css_position", "#root")
    assert root.get_text().startswith("第一条")
    rows = root.findall("css_position", ".item")
    assert [row.get_text() for row in rows] == ["第一条", "第二条"]
    assert len(root.findall("xpath_position", ".//a")) == 2
    assert len(root.findall("xpath_position", "//a")) == 2
    assert client.findall("css_position", ".absent") == []
    error(lambda: client.find("css_position", ".absent"), "ELEMENT_NOT_FOUND")
    error(lambda: client.find("css_position", ".item"), "AMBIGUOUS_SELECTOR")
    assert client.find("css_position", ".item", strict=False).get_text() == "第一条"
    error(lambda: client.find("css_position", "a["), "INVALID_SELECTOR")
    error(lambda: client.find("xpath_position", "//["), "INVALID_SELECTOR")
    error(lambda: client.findall("xpath_position", "//a/@href"), "INVALID_SELECTOR")
    passed("CSS/XPath find/findall without SCAN_PAGE; strict match, scoped and empty lists, syntax/type errors")

    assert rows[0].get("href") == "/first"
    assert rows[0].get_property("href").endswith("/first")
    assert rows[0].get("absent") is None
    assert rows[0].get("text") == "第一条"
    password = client.find("css_position", "#password")
    assert password.get("value") == password.get_property("value") == "[密码已隐藏]"
    assert root.get_all_texts("p") == ["段落一", "段落二"]
    assert client.get_all_texts("#root p") == ["段落一", "段落二"]
    assert "html" in root.get_all()
    error(lambda: client.find("css_position", "#long").get_text(), "TEXT_TRUNCATED")
    assert client.find("css_position", "#long").get_all()["textTruncated"] is True
    passed("Minimal text/attribute/property reads, raw/resolved URLs, missing attributes, password masking and explicit truncation")

    field = client.find("xpath_position", '//*[@id="field"]')
    field.input("new value")
    assert field.get_property("value") == "new value"
    field.clear()
    assert field.get_property("value") == ""
    client.find("css_position", "#action").click()
    assert client.find("css_position", "#clicks").get_text() == "1"
    assert not methods["RESOLVE_ELEMENT"] and not methods["SCAN_PAGE"]
    passed("Bound element operations reuse existing Action Executor without scan or detail lookup")

    client.find("css_position", "#insert").click()
    until(lambda: len(root.findall("css_position", ".item")) == 3)
    time.sleep(0.5)  # allow the default live scan to rebuild its mapping
    assert rows[1].get_text() == "第二条"
    root.get_all_texts("p")
    client.scan(scope="interactive")
    assert rows[1].get_text() == "第二条"
    assert root.find("css_position", "p", strict=False).get_text() == "段落一"
    client.find("css_position", "#clone").click()
    error(lambda: rows[1].get_text(), "ELEMENT_NOT_FOUND")
    error(lambda: rows[1].click(), "ELEMENT_NOT_FOUND")
    assert root.findall("css_position", ".item")[2].get_text() == "第二条"
    passed("Saved handles survive insertion and rescans, but reject replaced clones instead of retargeting")

    old = root
    client.find("css_position", "#next").click()
    until(lambda: (client.get_status().get("activeTab") or {}).get("url", "").endswith("/other"))
    until(lambda: client.find("css_position", "h1").get_text() == "第二页")
    error(lambda: old.get_text(), "STALE_PAGE")
    error(lambda: old.findall("xpath_position", ".//p"), "STALE_PAGE")
    assert client.find("xpath_position", "//h1").get_text() == "第二页"
    passed("Navigation loads a fresh content runtime and rejects old document and container handles")

print(json.dumps({"checks": checks, "methodCounts": dict(methods)}, ensure_ascii=True))
