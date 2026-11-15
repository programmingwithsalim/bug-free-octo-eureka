from mt5_candles import rates_to_rows


def test_rates_become_sorted_compact_rows():
    rates = [dict(time=120, open=2.0, high=3.0, low=1.0, close=2.5, tick_volume=9),
             dict(time=60, open=1.0, high=2.0, low=0.5, close=1.5, tick_volume=4)]
    assert rates_to_rows(rates) == [[60, 1.0, 2.0, 0.5, 1.5], [120, 2.0, 3.0, 1.0, 2.5]]
