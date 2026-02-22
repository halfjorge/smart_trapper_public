#target photoshop
app.bringToFront();

(function () {
  var prevDialogs = app.displayDialogs;
  app.displayDialogs = DialogModes.NO;

  function cTID(s){ return charIDToTypeID(s); }
  function sTID(s){ return stringIDToTypeID(s); }

  function sanitize(name) {
    return String(name).replace(/[\/\\:\*\?"<>\|]/g, "_");
  }

  // JSON stringify fallback (for PS where JSON is undefined)
  function stringifyJSON(obj) {
    try { if (typeof JSON !== "undefined" && JSON && JSON.stringify) return JSON.stringify(obj, null, 2); } catch(e){}
    function esc(s){ return String(s).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\r/g,"\\r").replace(/\n/g,"\\n").replace(/\t/g,"\\t"); }
    function ser(x, indent){
      indent = indent || ""; var next = indent + "  ";
      if (x === null || x === undefined) return "null";
      var t = typeof x;
      if (t === "number") return isFinite(x) ? String(x) : "null";
      if (t === "boolean") return x ? "true" : "false";
      if (t === "string") return '"' + esc(x) + '"';
      if (x instanceof Array){
        if (x.length === 0) return "[]";
        var a=[]; for (var i=0;i<x.length;i++) a.push(next + ser(x[i], next));
        return "[\n" + a.join(",\n") + "\n" + indent + "]";
      }
      var parts=[];
      for (var k in x){ if(!x.hasOwnProperty(k)) continue; parts.push(next + '"' + esc(k) + '": ' + ser(x[k], next)); }
      return "{\n" + parts.join(",\n") + "\n" + indent + "}";
    }
    return ser(obj, "");
  }

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

  function selectLayerShapeBestEffort(doc){
    doc.selection.deselect();
    try { selectTransparencyOfActiveLayer(); if(hasSelection(doc)) return true; } catch(e1){}
    try { doc.selection.deselect(); selectVectorMask(); if(hasSelection(doc)) return true; } catch(e2){}
    try { doc.selection.deselect(); selectLayerMask(); if(hasSelection(doc)) return true; } catch(e3){}
    doc.selection.deselect();
    return false;
  }

  function snapshotTopVisibility(doc){
    var s=[]; for (var i=0;i<doc.layers.length;i++) s[i]=doc.layers[i].visible;
    return s;
  }
  function restoreTopVisibility(doc, snap){
    for (var i=0;i<doc.layers.length;i++){ try{ doc.layers[i].visible = snap[i]; }catch(e){} }
  }

  function layerMeta(L){
    var bm="(unknown)", op=100, fop=100;
    try { bm = L.blendMode.toString(); } catch(e){}
    try { op = L.opacity; } catch(e){}
    try { fop = L.fillOpacity; } catch(e){}
    return { blendMode: bm, opacity: op, fillOpacity: fop };
  }

  // Export full-canvas binary mask PNG (white in selection, transparent outside) WITHOUT SHIFT
  function exportLayerMaskPNG(doc, layer, label, masksFolder){
    var snap = snapshotTopVisibility(doc);

    // Solo this top-level layer for predictable selection
    for (var i=0;i<doc.layers.length;i++){ try{ doc.layers[i].visible = false; }catch(e){} }
    layer.visible = true;
    doc.activeLayer = layer;

    if(!selectLayerShapeBestEffort(doc)){
      restoreTopVisibility(doc, snap);
      return null;
    }

    // Create a temp pixel layer filled white inside the printed-shape selection
    var tmp = doc.artLayers.add();
    tmp.name = "__TMP_MASK_FILL__";
    app.foregroundColor.rgb.red = 255;
    app.foregroundColor.rgb.green = 255;
    app.foregroundColor.rgb.blue = 255;
    doc.activeLayer = tmp;
    doc.selection.fill(app.foregroundColor, ColorBlendMode.NORMAL, 100, false);
    doc.selection.deselect();

    // Record where the mask content lives in the source doc
    var srcL = tmp.bounds[0].as("px");
    var srcT = tmp.bounds[1].as("px");

    // Copy full canvas pixels (includes transparency outside)
    doc.activeLayer = tmp;
    doc.selection.selectAll();
    doc.selection.copy();
    tmp.remove();

    // Paste into same-size transparent doc, then translate by delta so bounds match source
    var maskDoc = app.documents.add(doc.width, doc.height, doc.resolution, "mask_tmp",
                                    NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
    app.activeDocument = maskDoc;
    maskDoc.paste();

    var pasted = maskDoc.activeLayer;
    var dstL = pasted.bounds[0].as("px");
    var dstT = pasted.bounds[1].as("px");

    // Undo Photoshop centering by matching bounds
    pasted.translate(srcL - dstL, srcT - dstT);

    // Save PNG (no trim)
    var fileName = label + "_" + sanitize(layer.name) + ".png";
    var outFile = new File(masksFolder.fsName + "/" + fileName);

    var opts = new PNGSaveOptions();
    opts.compression = 9;
    opts.interlaced = false;

    maskDoc.saveAs(outFile, opts, true, Extension.LOWERCASE);
    maskDoc.close(SaveOptions.DONOTSAVECHANGES);

    // Restore host doc visibility
    app.activeDocument = doc;
    restoreTopVisibility(doc, snap);

    return fileName;
  }

  try {
    if (!app.documents.length) { alert("No document open."); return; }

    var doc = app.activeDocument;
    if (doc.layers.length < 3) {
      alert("Need at least 3 top-level layers:\nTOP = KEY\nBOTTOM = PAPER\nColors in between.");
      return;
    }

    var keyLayer   = doc.layers[0];
    var paperLayer = doc.layers[doc.layers.length - 1];

    // Pick export folder first
    var exportFolder = Folder.selectDialog("Select export folder for Smart Trapper (writes masks/ + job.json)");
    if (!exportFolder) return;

    // Prompt tolerance BEFORE creating job object (prevents 'job is undefined')
    var tolStr = prompt("Trap tolerance (pixels). Default 5:", "5");
    var tol = parseInt(tolStr, 10);
    if (isNaN(tol) || tol < 0) tol = 5;

    var masksFolder = new Folder(exportFolder.fsName + "/masks");
    if (!masksFolder.exists) masksFolder.create();

    // visible ArtLayers between KEY and PAPER (bottom->top)
    var colorLayers = [];
    for (var i = doc.layers.length - 2; i >= 1; i--) {
      var L = doc.layers[i];
      if (L.typename === "ArtLayer" && L.visible) colorLayers.push(L);
    }

    // STRICT schema job.json (includes blendMode/opacity/fillOpacity, plus tolerance)
    var job = {
      docName: doc.name,
      widthPx: Math.round(doc.width.as("px")),
      heightPx: Math.round(doc.height.as("px")),
      resolution: doc.resolution,
      tolerance: tol,
      keyLayerName: keyLayer.name,
      paperLayerName: paperLayer.name,
      colors: [],
      files: []
    };

    // KEY
    var km = layerMeta(keyLayer);
    var keyMask = exportLayerMaskPNG(doc, keyLayer, "KEY", masksFolder);
    if (!keyMask) { alert("Failed exporting KEY mask."); return; }
    job.files.push({
      kind:"KEY",
      name:keyLayer.name,
      blendMode: km.blendMode,
      opacity: km.opacity,
      fillOpacity: km.fillOpacity,
      png:"masks/" + keyMask
    });

    // COLORS
    for (var c = 0; c < colorLayers.length; c++) {
      var layer = colorLayers[c];
      var m = layerMeta(layer);

      var mask = exportLayerMaskPNG(doc, layer, (c + 1), masksFolder);
      if (!mask) continue;

      job.colors.push({
        name: layer.name,
        blendMode: m.blendMode,
        opacity: m.opacity,
        fillOpacity: m.fillOpacity
      });

      job.files.push({
        kind:"COLOR",
        name: layer.name,
        blendMode: m.blendMode,
        opacity: m.opacity,
        fillOpacity: m.fillOpacity,
        png:"masks/" + mask
      });
    }

    var jobFile = new File(exportFolder.fsName + "/job.json");
    jobFile.open("w");
    jobFile.encoding = "UTF8";
    jobFile.write(stringifyJSON(job));
    jobFile.close();

    alert("Export complete.\n\nFolder:\n" + exportFolder.fsName + "\nTolerance: " + tol);

  } catch (eTop) {
    alert("Export failed:\n" + eTop);
  } finally {
    try { app.displayDialogs = prevDialogs; } catch(e3) {}
  }

})();
