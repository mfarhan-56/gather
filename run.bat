@echo off
cd /d "%~dp0"
if not exist .venv (
  echo Creating virtual environment...
  python -m venv .venv
)
call .venv\Scripts\activate.bat
pip install -q -r requirements.txt
echo.
echo AETHER running at http://localhost:8000  (Ctrl+C to stop)
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
