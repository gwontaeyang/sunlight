```python
def correspond(scan, target, radius):
    offsets = []
    for x, y in scan:
        candidates = [(a - x, b - y) for a, b in target]
        if candidates:
            dx, dy = min(candidates, key=lambda d: d[0]**2 + d[1]**2)
            if dx**2 + dy**2 <= radius**2:
                offsets.append((dx, dy))
    return offsets
```

```python
scan = [(0, 0), (2, 0), (50, 0)]
target = [(0.1, 0), (2.1, 0)]
offsets = correspond(scan, target, 0.3)
assert len(offsets) == 2
tx, ty = (sum(axis) / len(offsets) for axis in zip(*offsets))
assert abs(tx - 0.1) < 1e-9 and abs(ty) < 1e-9
```
