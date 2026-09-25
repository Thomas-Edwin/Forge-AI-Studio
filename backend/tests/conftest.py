"""Test suite for the backend.

The suite runs against a fresh file-backed SQLite database (aiosqlite) per
test, so every test is hermetic. A file (not `:memory:`) is used deliberately:
aiosqlite connections are created and destroyed across different event loops
during a run, and in-memory SQLite silently loses all tables when a connection
dies — a file survives connection churn and keeps the suite deterministic on
every platform.
"""

import asyncio
import logging
import warnings
from pathlib import Path

import pytest

# --- Known-benign warning suppressions (deliberately narrow) ------------------
#
# 1) langchain-core serializer deprecation, raised by langgraph's own module
#    imports. These fire while conftest imports the app modules below — the
#    only time, because Python caches modules in sys.modules. The nested
#    `catch_warnings` block makes this ignore filter innermost during that
#    import, which beats every outer filter (including `-W error` from
#    addopts, which otherwise raises here before any marker/ini filter could
#    apply).
#    NB: match the EXACT emitted class. langchain passes a
#    LangChainPendingDeprecationWarning *instance* to warnings.warn(), and
#    CPython matches filters against the instance's class — a SIBLING of
#    LangChainDeprecationWarning (they derive from PendingDeprecationWarning
#    and DeprecationWarning respectively), so a LangChainDeprecationWarning
#    filter never matches. No message regex is used on purpose: CPython
#    lowercases warning text before regex matching.
from langchain_core._api.deprecation import LangChainPendingDeprecationWarning

with warnings.catch_warnings():
    warnings.simplefilter("ignore", category=LangChainPendingDeprecationWarning)

    import app.models  # noqa: F401, E402 - registers all models on Base.metadata
    from app.config.settings import Settings  # noqa: E402
    from app.database.base import Base  # noqa: E402
    from app.database.session import configure_engine, get_engine  # noqa: E402
    from app.main import create_app  # noqa: E402
    from fastapi.testclient import TestClient  # noqa: E402

# aiosqlite logs every statement at DEBUG when the process logger is verbose;
# keep test output readable regardless of the developer's .env log level.
logging.getLogger("aiosqlite").setLevel(logging.WARNING)

# 2) aiosqlite worker threads can outlive the event loop that spawned them when
#    a test finishes; delivering the final future then raises
#    RuntimeError("Event loop is closed") inside the thread after the test has
#    already passed. Attached as a `filterwarnings` marker to every test —
#    markers are applied after CLI `-W` filters and therefore keep `-W error`
#    runs green — and it wraps the whole runtest protocol including teardown.
#    Any OTHER unhandled thread exception still fails the run.
_AIOSQLITE_CLOSED_LOOP_IGNORE = (
    "ignore:Exception in thread[\\s\\S]*Event loop is closed[\\s\\S]*aiosqlite"
    ":pytest.PytestUnhandledThreadExceptionWarning"
)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Attach the known-benign aiosqlite filter to every test."""
    marker = pytest.mark.filterwarnings(_AIOSQLITE_CLOSED_LOOP_IGNORE)
    for item in items:
        item.add_marker(marker)


def _test_settings(db_path: Path) -> Settings:
    return Settings(
        app_env="test",
        database_url=f"sqlite+aiosqlite:///{db_path}",
        redis_url=None,
        cors_origins=["http://localhost:3000"],
        # Quiet test runs: the developer's .env may enable DEBUG logging.
        log_level="WARNING",
        # Tests must never call a real LLM provider: explicit None overrides any
        # LLM_API_KEY in the developer's .env / environment so the suite stays
        # hermetic, fast, and offline (agents run on the deterministic engine).
        llm_api_key=None,
        # >= 32 bytes so PyJWT does not warn about the HMAC key length (RFC 7518).
        secret_key="test-secret-key-0123456789abcdef0123456789abcdef",
    )


@pytest.fixture()
def app_settings(tmp_path: Path) -> Settings:
    """Per-test settings bound to a unique file-backed SQLite database."""
    return _test_settings(tmp_path / "test.db")


@pytest.fixture(autouse=True)
def _database(app_settings: Settings) -> None:
    """Fresh schema for every test."""
    # A unique database URL per test forces the process-wide engine to rebuild.
    configure_engine(app_settings)
    engine = get_engine()

    async def _init() -> None:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    asyncio.run(_init())


@pytest.fixture()
def client(app_settings: Settings) -> TestClient:
    application = create_app(settings=app_settings)
    return TestClient(application)
