(function () {
  'use strict';

  const surveyConfig = window.SURVEY_CONFIG || {};
  const surveySlug = surveyConfig.slug || 'akcakoyun';
  const sharedBase = surveyConfig.sharedBase || '.';
  const assetBase = (surveyConfig.assetBase || '.').replace(/\/$/, '');
  const assetUrl = function (path) {
    return assetBase + '/' + path.replace(/^\.\//, '');
  };
  const loading = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');
  const toast = document.getElementById('toast');
  let pointcloud = null;
  let texturedModel = null;
  let modelLoading = false;
  let cameraTemplate = null;
  const cameraObjects = [];

  function notify(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(function () { toast.classList.remove('visible'); }, 4500);
  }

  window.viewer = new Potree.Viewer(document.getElementById('potree_render_area'));
  const mobilePointBudget = 2000000;
  const restingPointBudget = window.innerWidth <= 600 ? mobilePointBudget : 6000000;
  const movingPointBudget = window.innerWidth <= 600 ? 750000 : 2000000;
  const potreeLoop = viewer.loop.bind(viewer);
  let survey3dActive = new URLSearchParams(location.search).get('view') !== '2d';

  function syncPotreeLoop() {
    const shouldRender = survey3dActive && !document.hidden;
    viewer.renderer.setAnimationLoop(null);
    if (shouldRender) {
      viewer.clock.getDelta();
      viewer.renderer.setAnimationLoop(potreeLoop);
    }
  }

  window.setSurvey3dActive = function (active) {
    survey3dActive = Boolean(active);
    viewer.setPointBudget(survey3dActive ? restingPointBudget : movingPointBudget);
    syncPotreeLoop();
  };

  document.addEventListener('visibilitychange', syncPotreeLoop);
  syncPotreeLoop();
  viewer.setEDLEnabled(true);
  viewer.setFOV(60);
  viewer.setPointBudget(survey3dActive ? restingPointBudget : movingPointBudget);
  viewer.setBackground('gradient');
  viewer.loadSettingsFromURL();
  viewer.scene.scene.add(new THREE.AmbientLight(0x404040, 2));
  const directional = new THREE.DirectionalLight(0xcccccc, 0.75);
  directional.position.set(0, 0, 1000000);
  viewer.scene.scene.add(directional);

  function setupSidebar() {
    viewer.setLanguage('en');
    $('#menu_tools').next().show();
    if (window.innerWidth > 600) viewer.toggleSidebar();
    else {
      document.body.classList.remove('mobile-3d-sidebar-open');
      const menuToggle = document.querySelector('.potree_menu_toggle');
      if (menuToggle) {
        menuToggle.onclick = function () {
          document.body.classList.toggle('mobile-3d-sidebar-open');
        };
        window.setTimeout(function () { document.body.appendChild(menuToggle); }, 0);
      }
    }

    $('#textured_model_button').html(
      '<label class="webodm-menu-row"><input id="toggle-textured-model" type="checkbox"> Show textured model</label>' +
      '<div id="model-progress" class="webodm-progress"></div>'
    );
    if (surveyConfig.hasTexturedModel === false) $('#textured_model_button').hide();
    $('#cameras_button').html(
      '<label class="webodm-menu-row"><input id="toggle-cameras" type="checkbox"> Show cameras</label>' +
      '<label class="webodm-menu-row">Scale <input id="camera-scale" type="range" min="1" max="12" step="0.5" value="4"></label>'
    );

    document.getElementById('toggle-textured-model').addEventListener('change', toggleTexturedModel);
    document.getElementById('toggle-cameras').addEventListener('change', toggleCameras);
    document.getElementById('camera-scale').addEventListener('input', function (event) {
      cameraObjects.forEach(function (camera) { camera.scale.setScalar(Number(event.target.value)); });
    });
  }

  viewer.loadGUI(setupSidebar);

  Potree.loadPointCloud(assetUrl('assets/entwine_pointcloud/ept.json'), 'Point Cloud', function (event) {
    if (event.type === 'loading_failed') {
      loadingText.textContent = 'The point cloud could not be loaded.';
      return;
    }
    pointcloud = event.pointcloud;
    pointcloud.material.size = 1;
    viewer.scene.addPointCloud(pointcloud);
    viewer.fitToScreen();
    viewer.setLengthUnitAndDisplayUnit('m', 'm');
    loading.classList.add('hidden');
  });

  function setPointCloudVisible(visible) {
    viewer.setEDLEnabled(true);
    viewer.setEDLOpacity(visible ? 1 : 0);
    if (window.innerWidth <= 600 && pointcloud) pointcloud.visible = visible;
  }

  function loadTexturedModel(callback) {
    if (texturedModel) return callback(texturedModel);
    if (modelLoading) return;
    modelLoading = true;
    const progress = document.getElementById('model-progress');
    progress.textContent = 'Loading…';
    const loader = new THREE.GLTFLoader();
    const draco = new THREE.DRACOLoader();
    draco.setDecoderPath(sharedBase + '/vendor/draco/');
    loader.setDRACOLoader(draco);
    loader.load(assetUrl('assets/textured_model.glb'), function (gltf) {
      texturedModel = gltf.scene;
      const center = texturedModel.CESIUM_RTC && texturedModel.CESIUM_RTC.center;
      if (center) {
        texturedModel.position.set(center[0], center[1], center[2] || 0);
      }
      viewer.scene.scene.add(texturedModel);
      modelLoading = false;
      progress.textContent = '';
      callback(texturedModel);
    }, function (event) {
      if (event.total) progress.textContent = 'Loading ' + Math.round(event.loaded / event.total * 100) + '%';
    }, function (error) {
      console.error('Textured model load failed', error);
      modelLoading = false;
      progress.textContent = 'Could not load model';
      document.getElementById('toggle-textured-model').checked = false;
    });
  }

  function alignModelToPointCloud(object) {
    if (!pointcloud || !object) return;
    let pcCenter = null;
    try {
      const box = viewer.getBoundingBox([pointcloud]);
      if (box && !box.isEmpty()) pcCenter = box.getCenter(new THREE.Vector3());
    } catch (ignore) { pcCenter = null; }
    if (!pcCenter) return;
    const modelBox = new THREE.Box3().setFromObject(object);
    if (modelBox.isEmpty()) return;
    const modelCenter = modelBox.getCenter(new THREE.Vector3());
    const dx = pcCenter.x - modelCenter.x;
    const dy = pcCenter.y - modelCenter.y;
    const dz = pcCenter.z - modelCenter.z;
    if (Math.abs(dx) > 1000 || Math.abs(dy) > 1000) {
      object.position.x += dx;
      object.position.y += dy;
      if (Math.abs(dz) > 100) object.position.z += dz;
    }
  }

  function toggleTexturedModel(event) {
    if (event.target.checked) {
      loadTexturedModel(function (object) {
        alignModelToPointCloud(object);
        object.visible = true;
        setPointCloudVisible(false);
      });
    } else if (texturedModel) {
      texturedModel.visible = false;
      setPointCloudVisible(true);
    }
  }

  function cameraMatrix(translation, rotation, scale) {
    const axis = new THREE.Vector3(-rotation[0], -rotation[1], -rotation[2]);
    const angle = axis.length();
    axis.normalize();
    const matrix = new THREE.Matrix4().makeRotationAxis(axis, angle);
    matrix.setPosition(new THREE.Vector3(translation[0], translation[1], translation[2]));
    matrix.scale(new THREE.Vector3(scale, scale, scale));
    return matrix.transpose();
  }

  function loadCameras(callback) {
    if (cameraObjects.length) return callback();
    Promise.all([
      fetch(assetUrl('assets/shots.geojson')).then(function (response) { return response.json(); }),
      new Promise(function (resolve, reject) {
        new THREE.GLTFLoader().load(sharedBase + '/vendor/camera.glb', function (gltf) { resolve(gltf.scene); }, undefined, reject);
      })
    ]).then(function (results) {
      const geojson = results[0];
      cameraTemplate = results[1];
      const scale = Number(document.getElementById('camera-scale').value);
      cameraTemplate.traverse(function (object) {
        if (object.material) {
          object.material = object.material.clone();
          object.material.transparent = true;
          object.material.opacity = 0.7;
        }
      });
      geojson.features.forEach(function (feature) {
        const camera = cameraTemplate.clone(true);
        camera.matrixAutoUpdate = false;
        camera.matrix.set.apply(camera.matrix, cameraMatrix(feature.properties.translation, feature.properties.rotation, scale).elements);
        camera.userData.filename = feature.properties.filename;
        viewer.scene.scene.add(camera);
        cameraObjects.push(camera);
      });
      callback();
    }).catch(function () {
      document.getElementById('toggle-cameras').checked = false;
      notify('Camera positions could not be loaded.');
    });
  }

  function toggleCameras(event) {
    if (event.target.checked) {
      loadCameras(function () { cameraObjects.forEach(function (camera) { camera.visible = true; }); });
    } else {
      cameraObjects.forEach(function (camera) { camera.visible = false; });
    }
  }

  document.getElementById('unit-selector').addEventListener('change', function (event) {
    if (event.target.value === 'metric') viewer.setLengthUnitAndDisplayUnit('m', 'm');
    else if (event.target.value === 'imperial') viewer.setLengthUnitAndDisplayUnit('m', 'ft');
    else viewer.setLengthUnitAndDisplayUnit('m', 'ft (US)');
  });

  document.getElementById('snapshot').addEventListener('click', function () {
    viewer.renderer.render(viewer.scene.scene, viewer.scene.getActiveCamera());
    const link = document.createElement('a');
    link.download = surveySlug + '-3d.png';
    link.href = viewer.renderer.domElement.toDataURL('image/png');
    link.click();
  });

  document.getElementById('share').addEventListener('click', function () {
    const shareData = { title: document.title, url: location.href };
    if (navigator.share) navigator.share(shareData).catch(function () {});
    else navigator.clipboard.writeText(location.href).then(function () { notify('Viewer link copied.'); });
  });

  function utmDefinition() {
    const extent = surveyConfig.extent4326;
    if (!Array.isArray(extent) || extent.length !== 4) return '+proj=utm +zone=35 +datum=WGS84 +units=m +no_defs';
    const centerLon = (extent[0] + extent[2]) / 2;
    const centerLat = (extent[1] + extent[3]) / 2;
    const zone = Math.max(1, Math.min(60, Math.floor((centerLon + 180) / 6) + 1));
    return '+proj=utm +zone=' + zone + (centerLat < 0 ? ' +south' : '') + ' +datum=WGS84 +units=m +no_defs';
  }

  document.getElementById('show-location').addEventListener('click', function () {
    if (!navigator.geolocation) return notify('Location is not supported by this browser.');
    notify('Waiting for GPS…');
    navigator.geolocation.getCurrentPosition(function (position) {
      const lon = position.coords.longitude;
      const lat = position.coords.latitude;
      const utm = proj4('EPSG:4326', utmDefinition(), [lon, lat]);
      const marker = new THREE.Mesh(new THREE.SphereGeometry(1.2, 18, 18), new THREE.MeshBasicMaterial({ color: 0x31b9ff }));
      marker.position.set(utm[0], utm[1], 310);
      viewer.scene.scene.add(marker);
      viewer.scene.view.position.set(utm[0] + 35, utm[1] - 35, 345);
      viewer.scene.view.lookAt(new THREE.Vector3(utm[0], utm[1], 285));
      notify('Approximate phone location shown in blue · accuracy ±' + Math.round(position.coords.accuracy) + ' m.');
    }, function () { notify('Location permission was not granted or GPS was unavailable.'); }, { enableHighAccuracy: true, timeout: 15000 });
  });
})();
