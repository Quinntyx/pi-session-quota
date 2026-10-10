"""Real Python socket waiter against the installed Pi runtime fixture."""
import asyncio
import json
import sys

sys.path.insert(0, sys.argv[2])
from pi_subagents.client import AsyncSockClient, SockClient, PiSockTurnFailed

print("CLIENT_STARTED", flush=True)
try:
    if sys.argv[3] == "async":
        async def wait():
            return await AsyncSockClient(sys.argv[1]).wait_settled(timeout=0.10)
        with asyncio.Runner() as runner:
            result = runner.run(wait())
    else:
        result = SockClient(sys.argv[1]).wait_settled(timeout=0.10)
except PiSockTurnFailed as error:
    # Weekly exhaustion and explicit abort terminate the pending caller;
    # neither is allowed to become a successful workflow result.
    if sys.argv[4] not in ("weekly", "abort"):
        raise
    result = {"failed": str(error)}
assert result is not None, "quota wait incorrectly exhausted the execution timeout"
print(json.dumps({"settled": result}), flush=True)
