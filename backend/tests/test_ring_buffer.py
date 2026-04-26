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


def test_min_new_words_gate_blocks_dispatch_on_silence():
    """Time elapsed alone isn't enough — without new words since the
    last dispatch we'd be feeding the LLM the same 200-word snapshot
    we already saw. The min-new-words gate prevents that."""
    rb = RingBuffer()
    # First dispatch: time gate trivially passes (last=0); new words = 0
    # but min=0 → passes. Records baseline at total_words=0.
    rb.append("s", "we should ship the cache feature this week")
    assert rb.should_dispatch_topology("s", 0.0, min_new_words=0) is True
    # Second dispatch: 0 new words since baseline → blocked even though
    # the time debounce of 0 is satisfied.
    assert rb.should_dispatch_topology("s", 0.0, min_new_words=8) is False
    # Add 8 more words → unblocked.
    rb.append("s", "actually let us reconsider redis as a cache layer")
    assert rb.should_dispatch_topology("s", 0.0, min_new_words=8) is True
    # New baseline recorded; immediate retry blocked again.
    assert rb.should_dispatch_topology("s", 0.0, min_new_words=8) is False


def test_recent_sentences():
    rb = RingBuffer()
    rb.append("s", "Hello world. How are you? I am fine.")
    sents = rb.recent_sentences("s", 2)
    assert len(sents) == 2
