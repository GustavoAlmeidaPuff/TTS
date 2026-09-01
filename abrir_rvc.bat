@echo off
chcp 65001 >nul
title Bancada do RVC - Voz TTS
cd /d "%~dp0"
echo Iniciando Bancada do RVC...
npx electron testes/rvc-bancada.js
pause
