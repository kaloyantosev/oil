"""
Vercel Serverless Entrypoint for OilWatch
"""
import sys
import traceback
from pathlib import Path

# Ensure the project root is in sys.path
root_dir = Path(__file__).resolve().parent.parent
if str(root_dir) not in sys.path:
    sys.path.insert(0, str(root_dir))

try:
    from main import app
except Exception as err:
    # Print the exact traceback to stderr so Vercel Application Logs capture it!
    print("FATAL ERROR: Failed to import main app:", file=sys.stderr)
    traceback.print_exc(file=sys.stderr)

    from fastapi import FastAPI
    from fastapi.responses import JSONResponse

    app = FastAPI(title="OilWatch Error Recovery")
    startup_error = str(err)
    startup_traceback = traceback.format_exc()

    @app.api_route("/{full_path:path}", methods=["GET", "POST", "PUT", "DELETE"])
    async def catch_all_error(full_path: str):
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "message": "Application failed during module load",
                "exception": startup_error,
                "traceback": startup_traceback,
            }
        )
