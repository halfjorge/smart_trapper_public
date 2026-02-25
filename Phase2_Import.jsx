#target photoshop
app.bringToFront();

(function () {

  var prevDialogs = app.displayDialogs;
  app.displayDialogs = DialogModes.NO;

  // ======================
  // DEBUG LOG
  // ======================
  var LOG = [];
  var DEBUG_DUMP_ACTIVE_LAYER = true;
  var USER_SELECTED_LAYER = null;
  function log(s){ LOG.push(String(s)); }
  function flushLog(folder){
    try{
      var f = new File(folder.fsName + "/import_debug_log.txt");
      f.open("w");
      f.encoding = "UTF8";
      f.write(LOG.join("\r\n"));
      f.close();
    }catch(e){}
  }

  // ======================
  // Helpers
  // ======================
  function safeTrim(s){ return String(s).replace(/^\s+|\s+$/g, ""); }
  function sanitizeName(name){ return safeTrim(String(name).replace(/[\/\\:\*\?"<>\|]/g, "_")); }
  function cTID(s){ return charIDToTypeID(s); }
  function sTID(s){ return stringIDToTypeID(s); }

  function hasSelection(doc){
    try { doc.selection.bounds; return true; }
    catch(e){ return false; }
  }

  function selectTransparencyOfActiveLayer(){
    var idChnl = cTID("Chnl");
    var refSel = new ActionReference();
    refSel.putProperty(idChnl, cTID("fsel"));
    var refTrsp = new ActionReference();
    refTrsp.putEnumerated(idChnl, idChnl, cTID("Trsp"));
    var desc = new ActionDescriptor();
    desc.putReference(cTID("null"), refSel);
    desc.putReference(cTID("T   "), refTrsp);
    executeAction(cTID("setd"), desc, DialogModes.NO);
  }

  function selectVectorMask(){
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putProperty(cTID("Chnl"), cTID("fsel"));
    desc.putReference(cTID("null"), ref);
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID("Path"), cTID("Ordn"), sTID("vectorMask"));
    desc.putReference(cTID("T   "), ref2);
    executeAction(cTID("setd"), desc, DialogModes.NO);
  }

  function selectLayerMask(){
    var desc = new ActionDescriptor();
    var ref = new ActionReference();
    ref.putProperty(cTID("Chnl"), cTID("fsel"));
    desc.putReference(cTID("null"), ref);
    var ref2 = new ActionReference();
    ref2.putEnumerated(cTID("Chnl"), cTID("Chnl"), cTID("Msk "));
    desc.putReference(cTID("T   "), ref2);
    executeAction(cTID("setd"), desc, DialogModes.NO);
  }

  function selectLayerShapeBestEffort(doc, label){
    doc.selection.deselect();

    try { selectTransparencyOfActiveLayer(); if(hasSelection(doc)){ log("  ["+label+"] selection=TRANSPARENCY"); return true; } }
    catch(e1){ log("  ["+label+"] transparency err: " + e1); }

    try { doc.selection.deselect(); selectVectorMask(); if(hasSelection(doc)){ log("  ["+label+"] selection=VECTOR_MASK"); return true; } }
    catch(e2){ log("  ["+label+"] vector err: " + e2); }

    try { doc.selection.deselect(); selectLayerMask(); if(hasSelection(doc)){ log("  ["+label+"] selection=LAYER_MASK"); return true; } }
    catch(e3){ log("  ["+label+"] mask err: " + e3); }

    doc.selection.deselect();
    log("  ["+label+"] FAILED selection");
    return false;
  }

  // JSON.parse fallback
  function parseJSON(txt){
    txt = String(txt);
    try { if (typeof JSON !== "undefined" && JSON && JSON.parse) return JSON.parse(txt); } catch(e1){}
    try { return eval("(" + txt + ")"); } catch(e2){
      throw new Error("Could not parse JSON: " + e2);
    }
  }

  function readTextFile(path){
    var f = new File(path);
    if(!f.exists) throw new Error("Missing file: " + path);
    f.open("r");
    f.encoding = "UTF8";
    var t = f.read();
    f.close();
    return t;
  }

  // ---- Cleanup old traps
  function removeOldTrapLayers(container){
    for (var i = container.layers.length - 1; i >= 0; i--){
      var L = container.layers[i];

      if (L.typename === "ArtLayer" && L.name.indexOf("TRAP__") === 0){
        try { L.remove(); } catch(e) {}
        continue;
      }
      if (L.typename === "LayerSet"){
        removeOldTrapLayers(L);
      }
    }
  }

  // ---- Visibility solo (TOP-LEVEL only) for sampling
  function snapshotTopLevelVisibility(doc){
    var snap = [];
    for(var i=0;i<doc.layers.length;i++) snap[i] = doc.layers[i].visible;
    return snap;
  }
  function restoreTopLevelVisibility(doc, snap){
    for(var i=0;i<doc.layers.length;i++){
      try { doc.layers[i].visible = snap[i]; } catch(e){}
    }
  }
  function topLevelAncestor(layer){
    var p = layer;
    while(p && p.parent && p.parent.typename !== "Document") p = p.parent;
    return p;
  }
  function soloLayerTopLevel(doc, layer){
    var snap = snapshotTopLevelVisibility(doc);
    for(var i=0;i<doc.layers.length;i++){
      try { doc.layers[i].visible = false; } catch(e){}
    }
    var anc = topLevelAncestor(layer);
    try { anc.visible = true; } catch(e){}
    try { layer.visible = true; } catch(e){}
    return snap;
  }

  // ---- Find sample point by scanning inside selection bounds
  function findSamplePointByScan(doc, scanStep){
    if(!hasSelection(doc)) return null;

    var b = doc.selection.bounds;
    var L = Math.floor(b[0].as("px"));
    var T = Math.floor(b[1].as("px"));
    var R = Math.floor(b[2].as("px"));
    var B = Math.floor(b[3].as("px"));

    var tmp = doc.channels.add();
    tmp.name = "__TMP_SEL_SCAN__";
    doc.selection.store(tmp);
    doc.selection.deselect();

    function testPoint(x,y){
      doc.selection.deselect();
      doc.selection.select([[x,y],[x+1,y],[x+1,y+1],[x,y+1]]);
      doc.selection.load(tmp, SelectionType.INTERSECT);
      return hasSelection(doc);
    }

    var found = null;
    for(var y2=T+1; y2<=B-2; y2+=scanStep){
      for(var x2=L+1; x2<=R-2; x2+=scanStep){
        if(testPoint(x2,y2)){ found = [x2,y2]; break; }
      }
      if(found) break;
    }

    doc.selection.deselect();
    try { tmp.remove(); } catch(e){}
    return found;
  }

  // ---- Sample SOURCE ink color (once per source)
  function sampleLayerInkColor(doc, layer){
    var snap = soloLayerTopLevel(doc, layer);
    var oldActive = doc.activeLayer;
    doc.activeLayer = layer;

    if(!selectLayerShapeBestEffort(doc, "SAMPLE=" + layer.name)){
      restoreTopLevelVisibility(doc, snap);
      try { doc.activeLayer = oldActive; } catch(e){}
      throw new Error("Could not create selection for sampling: " + layer.name);
    }

    var pt = findSamplePointByScan(doc, 25);
    if(!pt) pt = findSamplePointByScan(doc, 10);
    if(!pt) pt = findSamplePointByScan(doc, 4);
    if(!pt){
      doc.selection.deselect();
      restoreTopLevelVisibility(doc, snap);
      try { doc.activeLayer = oldActive; } catch(e){}
      throw new Error("Could not find sample point: " + layer.name);
    }

    var sampler = doc.colorSamplers.add([pt[0], pt[1]]);
    var c = sampler.color;
    sampler.remove();

    doc.selection.deselect();
    restoreTopLevelVisibility(doc, snap);
    try { doc.activeLayer = oldActive; } catch(e){}

    app.foregroundColor = c;
    log("  [SAMPLE] " + layer.name + " @ ("+pt[0]+","+pt[1]+")");
    return c;
  }

  // ---- Grouping helpers
  function wrapLayerInGroup(doc, layer, groupName){
    var g = doc.layerSets.add();
    g.name = groupName;
    g.move(layer, ElementPlacement.PLACEBEFORE);
    layer.move(g, ElementPlacement.INSIDE);
    return g;
  }

  function findColorGroup(doc, sourceLayerName){
    var want = "COLOR__" + sanitizeName(sourceLayerName);
    function walk(container){
      for(var i=0;i<container.layerSets.length;i++){
        var g = container.layerSets[i];
        if(g.name === want) return g;
        var hit = walk(g);
        if(hit) return hit;
      }
      return null;
    }
    return walk(doc);
  }

  function findArtLayerByName(container, name){
    for(var i=0;i<container.layers.length;i++){
      var L = container.layers[i];
      if(L.typename === "ArtLayer" && L.name === name) return L;
      if(L.typename === "LayerSet"){
        var hit = findArtLayerByName(L, name);
        if(hit) return hit;
      }
    }
    return null;
  }

  function createTrapLayerInSourceGroup(doc, sourceGroup, sourceBaseLayer, trapName){
    var newL = doc.artLayers.add();
    newL.name = trapName;
    newL.move(sourceGroup, ElementPlacement.INSIDE);
    try { newL.move(sourceBaseLayer, ElementPlacement.PLACEBEFORE); } catch(e){}
    return newL;
  }

  function applySourceAppearanceToTrap(trapLayer, sourceLayer){
    try { trapLayer.blendMode = sourceLayer.blendMode; } catch(e){}
    try { trapLayer.opacity = sourceLayer.opacity; } catch(e){}
    try { trapLayer.fillOpacity = sourceLayer.fillOpacity; } catch(e){}
    try { trapLayer.visible = sourceLayer.visible; } catch(e){}
  }

  // ======================
  // ALIGNMENT FIX:
  // Open PNG -> get its alpha bounds (srcL/srcT)
  // Paste into host -> get pasted alpha bounds (dstL/dstT)
  // Translate pasted by (src - dst) -> select alpha -> delete temp
  // ======================
  function selectionFromTrapPngIntoHost_ALIGN_BY_BOUNDS(hostDoc, pngFile){
    var d = app.open(pngFile);
    d.activeLayer = d.layers[0];
    d.selection.deselect();

    try { selectTransparencyOfActiveLayer(); } catch(e0){}
    if(!hasSelection(d)){
      try { d.close(SaveOptions.DONOTSAVECHANGES); } catch(e1){}
      return false;
    }

    var sb = d.selection.bounds;
    var srcL = sb[0].as("px");
    var srcT = sb[1].as("px");

    d.selection.selectAll();
    d.selection.copy();
    d.close(SaveOptions.DONOTSAVECHANGES);

    app.activeDocument = hostDoc;
    hostDoc.paste();
    var pasted = hostDoc.activeLayer;

    hostDoc.selection.deselect();
    hostDoc.activeLayer = pasted;

    try { selectTransparencyOfActiveLayer(); } catch(e2){}
    if(!hasSelection(hostDoc)){
      try { pasted.remove(); } catch(e3){}
      return false;
    }

    var hb = hostDoc.selection.bounds;
    var dstL = hb[0].as("px");
    var dstT = hb[1].as("px");

    var dx = srcL - dstL;
    var dy = srcT - dstT;

    try { pasted.translate(dx, dy); } catch(eMove){}

    hostDoc.selection.deselect();
    hostDoc.activeLayer = pasted;
    try { selectTransparencyOfActiveLayer(); } catch(e4){}
    var ok = hasSelection(hostDoc);

    try { pasted.remove(); } catch(e5){}
    return ok;
  }

  // =======================================================
  // DEBUG OVERLAY IMPORT (AUTO PLACE debug_*.png AT TOP)
  // =======================================================

  function ensureTopDebugGroup(doc){
    var g = null;
    for(var i=0;i<doc.layerSets.length;i++){
      if(doc.layerSets[i].name === "DEBUG__MASKS"){ g = doc.layerSets[i]; break; }
    }
    if(!g){
      g = doc.layerSets.add();
      g.name = "DEBUG__MASKS";
    }
    try { g.move(doc.layers[0], ElementPlacement.PLACEBEFORE); } catch(e){}
    return g;
  }

  function pastePngIntoHostAsLayer_ALIGN_BY_BOUNDS(hostDoc, pngFile, layerName){
    if(!pngFile.exists) return null;

    var d = app.open(pngFile);
    d.activeLayer = d.layers[0];
    d.selection.deselect();

    // Get source alpha bounds (for translation)
    try { selectTransparencyOfActiveLayer(); } catch(e0){}
    var srcL = 0, srcT = 0;
    if(hasSelection(d)){
      var sb = d.selection.bounds;
      srcL = sb[0].as("px");
      srcT = sb[1].as("px");
    }

    d.selection.selectAll();
    d.selection.copy();
    d.close(SaveOptions.DONOTSAVECHANGES);

    app.activeDocument = hostDoc;
    hostDoc.paste();
    var pasted = hostDoc.activeLayer;
    pasted.name = layerName;

    // Translate pasted so its alpha bounds match the source bounds
    hostDoc.selection.deselect();
    hostDoc.activeLayer = pasted;

    try { selectTransparencyOfActiveLayer(); } catch(e1){}
    if(hasSelection(hostDoc)){
      var hb = hostDoc.selection.bounds;
      var dstL = hb[0].as("px");
      var dstT = hb[1].as("px");
      var dx = srcL - dstL;
      var dy = srcT - dstT;
      try { pasted.translate(dx, dy); } catch(eMove){}
    }

    hostDoc.selection.deselect();
    return pasted;
  }

  function listDebugPngs(jobFolder){
    var files = jobFolder.getFiles(function(f){
      if(!(f instanceof File)) return false;
      var n = f.name.toLowerCase();
      if(n.indexOf("debug_") !== 0) return false;
      return n.slice(-4) === ".png";
    });

    files.sort(function(a,b){
      var A = a.name.toLowerCase(), B = b.name.toLowerCase();
      return (A < B) ? -1 : (A > B) ? 1 : 0;
    });

    return files;
  }

  function importDebugMasksToTop(doc, jobFolder){
    var debugFiles = listDebugPngs(jobFolder);
    if(!debugFiles || debugFiles.length === 0){
      log("No debug_*.png files found to import.");
      return;
    }

    var g = ensureTopDebugGroup(doc);

    for(var i=0;i<debugFiles.length;i++){
      var f = debugFiles[i];
      var layerName = "DEBUG__" + f.name.replace(/\.png$/i, "");

      log("Import debug png: " + f.fsName);

      var L = pastePngIntoHostAsLayer_ALIGN_BY_BOUNDS(doc, f, layerName);
      if(!L) continue;

      try { L.move(g, ElementPlacement.INSIDE); } catch(e1){}
      // put newest at top inside group
      try { L.move(g.layers[0], ElementPlacement.PLACEBEFORE); } catch(e2){}

      // overlay-friendly defaults
      try { L.blendMode = BlendMode.NORMAL; } catch(e3){}
      try { L.opacity = 100; } catch(e4){}
      try { L.visible = true; } catch(e5){}
    }

    try { g.move(doc.layers[0], ElementPlacement.PLACEBEFORE); } catch(e6){}
  }

  function dumpActiveLayerInfo(){
    var doc = app.activeDocument;
    var layer = null;
    try {
      layer = USER_SELECTED_LAYER;
      var _n = layer.name;
    } catch(eUserLayer) {
      layer = null;
    }
    if(!layer){
      try { layer = doc.activeLayer; } catch(eActiveLayer) {}
    }
    if(!layer){
      log("Dump target: <none>");
      log("No valid layer available for dump.");
      return;
    }

    var dumpTargetName = "<unnamed>";
    try { dumpTargetName = layer.name; } catch(eName) {}
    log("Dump target: " + dumpTargetName);

    var layerDesc = null;
    try{
      var refById = new ActionReference();
      refById.putIdentifier(cTID("Lyr "), layer.id);
      layerDesc = executeActionGet(refById);
    }catch(eById){
      try{
        var refTarget = new ActionReference();
        refTarget.putEnumerated(cTID("Lyr "), cTID("Ordn"), cTID("Trgt"));
        layerDesc = executeActionGet(refTarget);
      }catch(eTarget){}
    }
    if(!layerDesc){
      log("Unable to read descriptor for dump target.");
      return;
    }

    function typeIdName(id){
      try { return typeIDToStringID(id); } catch(e1){}
      try { return typeIDToCharID(id); } catch(e2){}
      return String(id);
    }

    function keyName(id){
      return typeIdName(id);
    }

    function readRGBFromDesc(colorDesc){
      var r = null, g = null, b = null;

      try{
        if(colorDesc.hasKey(sTID("red"))) r = Math.round(colorDesc.getDouble(sTID("red")));
      }catch(e1){}
      try{
        if(colorDesc.hasKey(sTID("green"))) g = Math.round(colorDesc.getDouble(sTID("green")));
      }catch(e2){}
      try{
        if(colorDesc.hasKey(sTID("blue"))) b = Math.round(colorDesc.getDouble(sTID("blue")));
      }catch(e3){}

      try{
        if(r === null && colorDesc.hasKey(cTID("Rd  "))) r = Math.round(colorDesc.getDouble(cTID("Rd  ")));
      }catch(e4){}
      try{
        if(g === null && colorDesc.hasKey(cTID("Grn "))) g = Math.round(colorDesc.getDouble(cTID("Grn ")));
      }catch(e5){}
      try{
        if(b === null && colorDesc.hasKey(cTID("Bl  "))) b = Math.round(colorDesc.getDouble(cTID("Bl  ")));
      }catch(e6){}

      if(r === null || g === null || b === null) return null;
      return { r:r, g:g, b:b };
    }

    var fillOpacityStr = "n/a";
    try { fillOpacityStr = String(layer.fillOpacity); } catch(eFill) {}

    var kindStr = "n/a";
    try { kindStr = String(layer.kind); } catch(eKind) {}

    log("=== ACTIVE LAYER INFO ===");
    log("Name: " + layer.name);
    log("DOM: typename=" + layer.typename + " kind=" + kindStr);
    log("Visible: " + layer.visible + " Opacity: " + layer.opacity + " FillOpacity: " + fillOpacityStr);
    log("BlendMode: " + layer.blendMode);

    var idContentLayer = sTID("contentLayer");
    var idAdjustment = sTID("adjustment");
    var hasContentLayer = layerDesc.hasKey(idContentLayer);
    var hasAdjustment = layerDesc.hasKey(idAdjustment);

    log("Descriptor has contentLayer: " + hasContentLayer);
    log("Descriptor has adjustment: " + hasAdjustment);

    if(hasAdjustment){
      try{
        var adjList = layerDesc.getList(idAdjustment);
        if(adjList.count === 0){
          log("Adjustment items: (none)");
        } else {
          log("Adjustment items:");
          for(var i=0; i<adjList.count; i++){
            var classId = null;
            var name = "unknown";
            try { classId = adjList.getClass(i); } catch(eA1){}
            if(classId === null){
              try { classId = adjList.getObjectType(i); } catch(eA2){}
            }
            if(classId !== null){
              name = keyName(classId);
            }
            log("  [" + i + "] type=" + name + " id=" + classId);
          }
        }
      }catch(eAdj){
        log("Adjustment items read error: " + eAdj);
      }
    }

    if(hasContentLayer){
      try{
        var contentDesc = layerDesc.getObjectValue(idContentLayer);
        var idType = sTID("type");
        var idColor = sTID("color");
        var solidTypeName = "";
        var typeDesc = null;

        if(contentDesc.hasKey(idType)){
          try {
            solidTypeName = keyName(contentDesc.getObjectType(idType));
          } catch(eT1) {}
          try {
            typeDesc = contentDesc.getObjectValue(idType);
          } catch(eT2) {}
        }

        if(typeDesc !== null && solidTypeName === "solidColorLayer"){
          var colorDesc = null;
          try {
            if(typeDesc.hasKey(idColor)) colorDesc = typeDesc.getObjectValue(idColor);
          } catch(eC1) {}
          if(colorDesc === null){
            try {
              if(typeDesc.hasKey(cTID("Clr "))) colorDesc = typeDesc.getObjectValue(cTID("Clr "));
            } catch(eC2) {}
          }

          if(colorDesc !== null){
            var rgb = readRGBFromDesc(colorDesc);
            if(rgb){
              log("SolidFillRGB: R=" + rgb.r + " G=" + rgb.g + " B=" + rgb.b);
            }
          }
        }
      }catch(eContent){
        log("SolidFillRGB read error: " + eContent);
      }
    }

    log("=== END ACTIVE LAYER INFO ===");
  }
  // ======================
  // MAIN
  // ======================
  var folder = null;

  try{
    if(!documents.length){
      alert("Open your PSD first, then run this importer.");
      return;
    }

    var hostDoc = app.activeDocument;
    try { USER_SELECTED_LAYER = hostDoc.activeLayer; } catch(eSel) { USER_SELECTED_LAYER = null; }

    // If controller provided folder, use it.
// Otherwise fall back to manual selection.
if ($.global.PHASE2_IMPORT_FOLDER) {
    folder = new Folder($.global.PHASE2_IMPORT_FOLDER);
    log("Using controller-provided folder: " + folder.fsName);
} else {
    folder = Folder.selectDialog("Select JOB folder (contains traps.json + traps/ + debug_*.png)");
}

if(!folder) return;

    log("Folder: " + folder.fsName);

    if(DEBUG_DUMP_ACTIVE_LAYER){
      dumpActiveLayerInfo();
      flushLog(folder);
      alert("Dump complete. See import_debug_log.txt");
      return;
    }

    var trapsObj = parseJSON(readTextFile(folder.fsName + "/traps.json"));
    if(!trapsObj || !trapsObj.traps || trapsObj.traps.length === 0){
      log("No traps found in traps.json");
      flushLog(folder);
      alert("No traps found. See import_debug_log.txt");
      return;
    }

    // Ensure COLOR__ groups exist (wrap visible ArtLayers between KEY and PAPER if needed)
    if(hostDoc.layers.length < 3){
      alert("PSD needs at least 3 top-level layers (KEY top, PAPER bottom, colors in between).");
      return;
    }

    var colorsBottomToTop = [];
    for(var i = hostDoc.layers.length - 2; i >= 1; i--){
      var L = hostDoc.layers[i];
      if(L.typename === "ArtLayer" && L.visible) colorsBottomToTop.push(L);
    }

    for(var c=0;c<colorsBottomToTop.length;c++){
      var base = colorsBottomToTop[c];
      var existing = findColorGroup(hostDoc, base.name);
      if(!existing){
        log("Wrapping missing group for: " + base.name);
        wrapLayerInGroup(hostDoc, base, "COLOR__" + sanitizeName(base.name));
      }
    }

    // Cache sampled colors per SOURCE
    var inkCache = {};
    var imported = 0;

    log("Removing old TRAP__ layers...");
    removeOldTrapLayers(hostDoc);

    var skippedSel = 0;

    for(var t=0; t<trapsObj.traps.length; t++){
      var spec = trapsObj.traps[t]; // {source, target, png}
      log("--- Trap #" + (t+1) + " " + spec.source + " over " + spec.target);

      var sourceGroup = findColorGroup(hostDoc, spec.source);
      if(!sourceGroup){
        log("  SKIP: missing COLOR__ group for source: " + spec.source);
        continue;
      }

      var sourceBase = findArtLayerByName(sourceGroup, spec.source);
      if(!sourceBase){
        log("  SKIP: no base ArtLayer named '" + spec.source + "' inside " + sourceGroup.name);
        continue;
      }

      // Sample ink once per source
      if(!inkCache[spec.source]){
        inkCache[spec.source] = sampleLayerInkColor(hostDoc, sourceBase);
      } else {
        app.foregroundColor = inkCache[spec.source];
      }

      var pngFile = new File(folder.fsName + "/" + spec.png);
      if(!pngFile.exists){
        log("  SKIP: missing PNG: " + pngFile.fsName);
        continue;
      }

      hostDoc.selection.deselect();

      // Build selection aligned to correct pixel coords
      if(!selectionFromTrapPngIntoHost_ALIGN_BY_BOUNDS(hostDoc, pngFile)){
        log("  SKIP: could not load selection from trap PNG");
        hostDoc.selection.deselect();
        skippedSel++;
        continue;
      }

      var trapName = "TRAP__" + sanitizeName(spec.source) + "_over_" + sanitizeName(spec.target);
      var trapLayer = createTrapLayerInSourceGroup(hostDoc, sourceGroup, sourceBase, trapName);
      applySourceAppearanceToTrap(trapLayer, sourceBase);

      hostDoc.activeLayer = trapLayer;
      hostDoc.selection.fill(app.foregroundColor, ColorBlendMode.NORMAL, 100, false);
      hostDoc.selection.deselect();

      imported++;
      log("  âœ“ Imported: " + trapName + " (in " + sourceGroup.name + ")");
    }

    log("=== SUMMARY ===");
    log("Imported: " + imported);
    log("Skipped (selection load fail): " + skippedSel);

    // NEW: auto-import debug overlays
    log("Importing debug_*.png masks to top of stack...");
    importDebugMasksToTop(hostDoc, folder);

    flushLog(folder);

    alert("Import complete.\nImported: " + imported + "\n\nSee import_debug_log.txt");

  } catch(eTop){
    log("FATAL: " + eTop);
    try { if(folder) flushLog(folder); } catch(e2){}
    alert("Import failed.\nSee import_debug_log.txt in the export folder.");
  } finally {
    try { app.displayDialogs = prevDialogs; } catch(e3) {}
  }

})();



