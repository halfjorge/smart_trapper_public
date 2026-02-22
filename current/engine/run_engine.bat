@echo off
REM Run from SmartTrapperB1\engine\
REM Usage:
REM   run_engine.bat "C:\path\to\JOB_FOLDER" 5
set JOB=%~1
set PX=%~2
if "%JOB%"=="" (
  echo Usage: run_engine.bat "C:\path\to\JOB_FOLDER" 5
  exit /b 1
)
if "%PX%"=="" set PX=5
target\release\smart_trapper_b1.exe "%JOB%" %PX%
