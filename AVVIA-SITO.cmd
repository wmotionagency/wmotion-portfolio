@echo off
title W Motion - Anteprima
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js non e disponibile su questo computer.
  echo Installa Node.js e riprova.
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo Preparo il sito per la prima apertura...
  call npm run build
  if errorlevel 1 (
    echo Non e stato possibile preparare il sito.
    pause
    exit /b 1
  )
)

node server.mjs
