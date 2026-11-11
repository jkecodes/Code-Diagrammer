from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def child(node, name):
    """First direct child with that name."""
    return next(c for c in node.children if c.name == name)


def names(node):
    """Direct child names in order."""
    return [c.name for c in node.children]


def edges(node):
    """Edges as (from_name, to_name, shape, uncertain); $in/$out kept."""
    by_id = {c.id: c.name for c in node.children}
    return [(by_id.get(e.from_, e.from_), by_id.get(e.to, e.to), e.shape, e.uncertain)
            for e in node.edges]
