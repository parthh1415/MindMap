from backend.ring_buffer import RingBuffer


def test_appends_and_caps():
    rb = RingBuffer(max_words=5)
    rb.append("s", "a b c d e f g")
    snap = rb.snapshot("s")
    assert snap.split() == ["c", "d", "e", "f", "g"]


def test_debounce():
    rb = RingBuffer()
    assert rb.should_dispatch_topology("s", 1.2) is True
    assert rb.should_dispatch_topology("s", 1.2) is False


def test_recent_sentences():
    rb = RingBuffer()
    rb.append("s", "Hello world. How are you? I am fine.")
    sents = rb.recent_sentences("s", 2)
    assert len(sents) == 2
