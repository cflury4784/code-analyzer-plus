# batch_filter.py
# Usage: from batch_filter import create_batch_filter
# Returns an is_excluded(path: str) -> bool closure configured for
# the caller's exclusion sets.

from __future__ import annotations


def create_batch_filter(
    prefixes: list[str] | None = None,
    exact_names: set[str] | None = None,
) -> callable:
    """Return an is_excluded(path) predicate.

    Args:
        prefixes:    Path prefixes (forward-slash normalized) to exclude.
        exact_names: Exact file names (basename only) to exclude.

    Returns:
        Callable[[str], bool] — True when the path should be excluded.
    """
    _prefixes: list[str] = prefixes if prefixes is not None else []
    _exact_names: set[str] = exact_names if exact_names is not None else set()

    def is_excluded(path: str) -> bool:
        normalized = path.replace("\\", "/")
        name = normalized.split("/")[-1]
        if name in _exact_names:
            return True
        for prefix in _prefixes:
            if normalized == prefix.rstrip("/") or normalized.startswith(prefix):
                return True
        return False

    return is_excluded
