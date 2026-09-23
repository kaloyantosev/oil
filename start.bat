@echo off
title OilWatch — Oil Shipping Intelligence
color 0B

echo.
echo  =========================================
echo   OilWatch - Global Oil Shipping Dashboard
echo  =========================================
echo.

:: Move to script directory
cd /d "%~dp0"

:: ── Check for .env ────────────────────────────────────────────
if not exist ".env" (
    if exist ".env.template" (
        copy ".env.template" ".env" >nul
        echo  [!] .env file created from template.
        echo.
        echo  *** IMPORTANT: Open .env in a text editor and add your
        echo  *** three free API keys before continuing.
        echo.
        echo  Keys needed ^(all free, no credit card^):
        echo    1. AISStream.io  → https://aisstream.io  ^(sign in with GitHub^)
        echo    2. EIA           → https://www.eia.gov/opendata/
        echo    3. Gemini AI     → https://aistudio.google.com/apikey
        echo.
        start notepad ".env"
        echo  Edit the .env file that just opened, then run start.bat again.
        echo.
        pause
        exit /b 0
    ) else (
        echo  [!] .env.template missing. Re-download the project.
        pause
        exit /b 1
    )
)

:: ── Create or activate venv ───────────────────────────────────
if not exist "venv\Scripts\python.exe" (
    echo  [*] Creating Python virtual environment...
    python -m venv venv
    if errorlevel 1 (
        echo  [ERROR] Failed to create venv. Is Python 3.11+ installed?
        pause
        exit /b 1
    )
    echo  [+] Virtual environment created.
    echo.
)

call venv\Scripts\activate.bat

:: ── Install / update dependencies ────────────────────────────
echo  [*] Checking dependencies...
pip install -r requirements.txt --quiet --disable-pip-version-check
if errorlevel 1 (
    echo  [ERROR] pip install failed. Check your internet connection.
    pause
    exit /b 1
)
echo  [+] Dependencies ready.
echo.

:: ── Launch ────────────────────────────────────────────────────
echo  [*] Starting OilWatch...
echo.
echo  ─────────────────────────────────────────
echo   Open your browser: http://localhost:8000
echo   Press Ctrl+C to stop the server
echo  ─────────────────────────────────────────
echo.

python main.py

echo.
echo  OilWatch stopped.
pause
