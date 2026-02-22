#target photoshop
app.bringToFront();

(function () {

  // --- Paths (same folder as this Run_All.jsx) ---
  var base = File($.fileName).parent.fsName;
  var EXPORT_SCRIPT = base + "\\Phase2_Export.jsx";
  var IMPORT_SCRIPT = base + "\\Phase2_Import.jsx";

  // IMPORTANT: point directly to your engine build output (no copying exe)
  var TRAPPER_EXE = "C:\\Users\\Valued Customer\\Desktop\\trapper\\SmartTrapperB1\\engine\\target\\release\\smart_trapper_b1.exe";

  if (!app.documents.length) { alert("Open PSD first."); return; }
  var doc = app.activeDocument;

  // ----------------------------
  // Blend Mode Detection + Prompt
  // Default = PLATES
  // ----------------------------
  function isBlendLikeLayer(L){
    try {
      if (L.typename !== "ArtLayer") return false;
      if (!L.visible) return false;
      if (L.blendMode !== BlendMode.NORMAL) return true;
      if (L.opacity !== 100) return true;
      if (L.fillOpacity !== 100) return true;
    } catch(e){}
    return false;
  }

  var hasBlend = false;
  for (var i=0; i<doc.layers.length; i++){
    if (isBlendLikeLayer(doc.layers[i])) { hasBlend = true; break; }
  }

  $.global.PHASE2_MODE = "plates"; // "plates" | "overprint"

  if (hasBlend) {
    var okPlates = confirm(
      "Non-normal blend/transparency layers detected.\n\n" +
      "OK  = Continue in PLATE mode (AUTO-KNOCKOUT ON)\n\n" +
      "Cancel = Switch to OVERPRINT mode\n" +
      "(keeps intentional overlaps; traps outer boundary only)"
    );
    $.global.PHASE2_MODE = okPlates ? "plates" : "overprint";
  }

  // ===============================
  // 1) RUN EXPORT
  // ===============================
  var exportFile = new File(EXPORT_SCRIPT);
  if (!exportFile.exists) { alert("Export script not found:\n" + EXPORT_SCRIPT); return; }

  $.global.PHASE2_LAST_EXPORT_FOLDER = null;
  $.evalFile(exportFile);

  if (!$.global.PHASE2_LAST_EXPORT_FOLDER) {
    alert("Export did not return folder path (PHASE2_LAST_EXPORT_FOLDER).");
    return;
  }

  var jobFolder = $.global.PHASE2_LAST_EXPORT_FOLDER;

  // ===============================
  // 2) TRAP PROMPT (scaled default: 5px @ 300dpi)
  // ===============================
  var docRes = doc.resolution;
  var scaledDefault = Math.round(5 * (docRes / 300.0));
  if (scaledDefault < 0) scaledDefault = 0;

  var trapPxStr = prompt(
    "Trap width in pixels.\nBaseline: 5px @ 300dpi\nDocument: " + docRes + " dpi",
    String(scaledDefault)
  );
  if (trapPxStr === null) return;

  var trapPx = parseFloat(trapPxStr);
  if (isNaN(trapPx) || trapPx < 0) trapPx = scaledDefault;
  trapPx = Math.round(trapPx);

  // ===============================
  // 3) RUN RUST (via .BAT)
  // ===============================
  var exeFile = new File(TRAPPER_EXE);
  if (!exeFile.exists) { alert("TRAPPER_EXE not found:\n" + TRAPPER_EXE); return; }

  var trapperLogPath = jobFolder + "\\trapper_log.txt";
  var errLvlPath     = jobFolder + "\\errorlevel.txt";
  var batPath        = jobFolder + "\\run_trapper.bat";

  try { var a = new File(trapperLogPath); if (a.exists) a.remove(); } catch(e1){}
  try { var b = new File(errLvlPath);     if (b.exists) b.remove(); } catch(e2){}
  try { var c = new File(batPath);        if (c.exists) c.remove(); } catch(e3){}

  var bat = new File(batPath);
  bat.open("w");
  bat.writeln("@echo off");
  bat.writeln("echo RUNNING> \"" + trapperLogPath + "\"");
  bat.writeln("\"" + TRAPPER_EXE + "\" \"" + jobFolder + "\" " + trapPx + " 1>>\"" + trapperLogPath + "\" 2>>&1");
  bat.writeln("echo ERRORLEVEL:%ERRORLEVEL%>> \"" + trapperLogPath + "\"");
  bat.writeln("echo %ERRORLEVEL%> \"" + errLvlPath + "\"");
  bat.close();

  app.system('cmd.exe /c ""' + batPath + '""');

  var trapsCheck = new File(jobFolder + "\\traps.json");
  if (!trapsCheck.exists) {
    alert("Rust did not generate traps.json.\n\nCheck:\n" + trapperLogPath + "\n" + errLvlPath);
    return;
  }

  // ===============================
  // 4) RUN IMPORT
  // ===============================
  $.global.PHASE2_IMPORT_FOLDER = jobFolder;

  var importFile = new File(IMPORT_SCRIPT);
  if (!importFile.exists) { alert("Import script not found:\n" + IMPORT_SCRIPT); return; }

  $.evalFile(importFile);

})();