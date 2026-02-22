#target photoshop
app.bringToFront();

(function () {
  var LOG = [];
  function log(s){ LOG.push(String(s)); }

  function showLog(){
    var w = new Window("dialog", "IMPORT LOG");
    w.orientation = "column";
    w.alignChildren = ["fill","fill"];
    var t = w.add("edittext", undefined, LOG.join("\r\n"), {multiline:true, scrolling:true});
    t.preferredSize = [900,600];
    w.add("button", undefined, "OK", {name:"ok"});
    w.show();
  }

  function safeTrim(s){ return String(s).replace(/^\s+|\s+$/g, ""); }
  function sanitizeName(name){ return safeTrim(String(name).replace(/[\/\\:\*\?"<>\|]/g, "_")); }
  function cTID(s){ return charIDToTypeID(s); }

  function hasSelection(doc){
    try { doc.selection.bounds; return true; } catch(e){ return false; }
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

  function findColorGroup(doc, sourceLayerName){
    var want = "COLOR__" + sanitizeName(sourceLayerName);
    for(var i=0;i<doc.layerSets.length;i++){
      if(doc.layerSets[i].name === want) return doc.layerSets[i];
    }
    return null;
  }

  function findBaseArtLayerInGroup(group){
    for(var i=0;i<group.layers.length;i++){
      if(group.layers[i].typename === "ArtLayer") return group.layers[i];
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

  function readJsonFile(path){
    var f = new File(path);
    if(!f.exists) throw new Error("Missing file: " + path);
    f.open("r");
    f.encoding = "UTF8";
    var txt = f.read();
    f.close();
    if(typeof JSON === "undefined" || !JSON || !JSON.parse){
      throw new Error("JSON.parse not available in this Photoshop.");
    }
    return JSON.parse(txt);
  }

  function openPngAndLoadSelection(pngFile){
    var d = app.open(pngFile);
    d.activeLayer = d.layers[0];
    d.selection.deselect();
    try { selectTransparencyOfActiveLayer(); } catch(e){}
    return { doc:d, ok: hasSelection(d) };
  }

  function sampleOnePixelColorFromLayer(doc, layer){
    var oldActive = doc.activeLayer;
    doc.activeLayer = layer;

    doc.selection.deselect();
    try { selectTransparencyOfActiveLayer(); } catch(e){}
    if(!hasSelection(doc)){
      doc.activeLayer = oldActive;
      throw new Error("Cannot sample color, no transparency selection: " + layer.name);
    }
    var b = doc.selection.bounds;
    var x = Math.floor(b[0].as("px")) + 2;
    var y = Math.floor(b[1].as("px")) + 2;

    var sampler = doc.colorSamplers.add([x,y]);
    var c = sampler.color;
    sampler.remove();
    doc.selection.deselect();

    doc.activeLayer = oldActive;
    return c;
  }

  // MAIN
  var prevDialogs = app.displayDialogs;
  try {
    app.displayDialogs = DialogModes.NO;

    if(!documents.length){
      alert("Open the PSD you exported from first.");
      return;
    }
    var hostDoc = app.activeDocument;

    var folder = Folder.selectDialog("Select the JOB folder (contains job.json and traps.json)");
    if(!folder) return;

    var job = readJsonFile(folder.fsName + "/job.json");
    var traps = readJsonFile(folder.fsName + "/traps.json");

    log("Importing into: " + hostDoc.name);
    log("Traps count: " + traps.traps.length);

    var imported = 0;

    for(var i=0;i<traps.traps.length;i++){
      var t = traps.traps[i]; // {source, target, png}

      var sourceGroup = findColorGroup(hostDoc, t.source);
      if(!sourceGroup){
        log("SKIP: missing source group for " + t.source);
        continue;
      }
      var sourceBase = findBaseArtLayerInGroup(sourceGroup);
      if(!sourceBase){
        log("SKIP: no base ArtLayer in group for " + t.source);
        continue;
      }

      var png = new File(folder.fsName + "/" + t.png);
      if(!png.exists){
        log("SKIP: missing trap png: " + png.fsName);
        continue;
      }

      var opened = openPngAndLoadSelection(png);
      if(!opened.ok){
        try { opened.doc.close(SaveOptions.DONOTSAVECHANGES); } catch(e){}
        log("SKIP: empty trap selection: " + t.png);
        continue;
      }

      opened.doc.selection.copy();
      app.activeDocument = hostDoc;

      hostDoc.paste();
      var pasted = hostDoc.activeLayer;
      pasted.name = "__TMP_TRAP_PASTE__";

      hostDoc.selection.deselect();
      try { selectTransparencyOfActiveLayer(); } catch(e){}
      if(!hasSelection(hostDoc)){
        try { pasted.remove(); } catch(e){}
        try { opened.doc.close(SaveOptions.DONOTSAVECHANGES); } catch(e){}
        log("SKIP: failed to load selection from pasted trap: " + t.png);
        continue;
      }
      try { pasted.remove(); } catch(e){}
      try { opened.doc.close(SaveOptions.DONOTSAVECHANGES); } catch(e){}

      var trapName = "TRAP__" + sanitizeName(t.source) + "_over_" + sanitizeName(t.target);
      var trapLayer = createTrapLayerInSourceGroup(hostDoc, sourceGroup, sourceBase, trapName);

      applySourceAppearanceToTrap(trapLayer, sourceBase);
      hostDoc.activeLayer = trapLayer;

      var ink = sampleOnePixelColorFromLayer(hostDoc, sourceBase);
      app.foregroundColor = ink;

      hostDoc.selection.fill(app.foregroundColor, ColorBlendMode.NORMAL, 100, false);
      hostDoc.selection.deselect();

      imported++;
      log("IMPORTED: " + trapName);
    }

    alert("Import done.\nImported trap layers: " + imported);
    showLog();

  } catch(eTop){
    log("FATAL: " + eTop);
    try { showLog(); } catch(e2){}
    alert("Import failed. See log.");
  } finally {
    try { app.displayDialogs = prevDialogs; } catch(e3){}
  }
})();
