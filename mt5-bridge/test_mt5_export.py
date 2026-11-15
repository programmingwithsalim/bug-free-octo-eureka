from mt5_export import build_trades


def deal(ticket, pos, typ, entry, vol, price, time, profit=0.0, comm=0.0, swap=0.0, order=1, symbol="XAUUSDm"):
    return dict(ticket=ticket, position_id=pos, type=typ, entry=entry, volume=vol, price=price, time=time,
                profit=profit, commission=comm, swap=swap, fee=0.0, order=order, symbol=symbol, comment="")


def test_long_round_trip_nets_costs_and_sl_tp():
    ds = [deal(1, 10, 0, 0, 0.1, 2000.0, 1_700_000_000, order=5),
          deal(2, 10, 1, 1, 0.1, 2010.0, 1_700_003_600, profit=100.0, comm=-0.7, swap=-0.3)]
    [t] = build_trades(ds, {5: (1990.0, 2020.0)})
    assert (t["id"], t["side"], t["entry"], t["exit"], t["size"]) == ("mt5-10", "long", 2000.0, 2010.0, 0.1)
    assert t["pnl"] == 99.0 and t["fees"] == 1.0
    assert t["stopLoss"] == 1990.0 and t["takeProfit"] == 2020.0
    assert t["openTime"] == "2023-11-14T22:13:20Z"


def test_short_partial_closes_aggregate_and_skip_open_partial_balance():
    ds = [deal(1, 20, 1, 0, 0.2, 1.1000, 100, symbol="EURUSDm"),
          deal(2, 20, 0, 1, 0.1, 1.0990, 200, profit=10.0),
          deal(3, 20, 0, 1, 0.1, 1.0980, 300, profit=20.0),
          deal(4, 21, 0, 0, 0.1, 1.2, 400),   # still open
          deal(5, 22, 0, 0, 0.3, 1.2, 500),   # only 0.1 of 0.3 closed
          deal(6, 22, 1, 1, 0.1, 1.2, 600),
          deal(7, 0, 2, 0, 0.0, 0.0, 50, profit=500.0)]  # deposit
    [t] = build_trades(ds)
    assert t["side"] == "short" and t["size"] == 0.2 and t["pnl"] == 30.0
    assert round(t["exit"], 6) == 1.0985
