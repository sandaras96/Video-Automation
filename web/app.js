/**
 * ULTRA STUDIO — Interactive Single Page Application Logic
 * Real-time SSE streaming, Batch Queue, Media Player, and Hardware Diagnostics
 */

document.addEventListener('DOMContentLoaded', () => {
  // State
  let projects = [];
  let currentProjectId = null;
  let pipelineSteps = [];
  let eventSource = null;
  let selectedResolution = '2k';

  // DOM Elements - Navigation & Status
  const cdpStatusPill = document.getElementById('cdp-status-pill');
  const cdpDot = document.getElementById('cdp-dot');
  const btnLaunchCdp = document.getElementById('btn-launch-cdp');
  const apiKeysCount = document.getElementById('api-keys-count');
  const btnOpenSettings = document.getElementById('btn-open-settings');

  // DOM Elements - Sidebar
  const projectsList = document.getElementById('projects-list');
  const queueCount = document.getElementById('queue-count');
  const emptyQueueMsg = document.getElementById('empty-queue-msg');
  const btnShowCreator = document.getElementById('btn-show-creator');

  // DOM Elements - Creator
  const creatorView = document.getElementById('creator-view');
  const tabSingleMode = document.getElementById('tab-single-mode');
  const tabBatchMode = document.getElementById('tab-batch-mode');
  const groupSingleTopic = document.getElementById('group-single-topic');
  const groupBatchTopics = document.getElementById('group-batch-topics');
  const inputTopic = document.getElementById('input-topic');
  const inputBatchTopics = document.getElementById('input-batch-topics');
  const checkHookEnabled = document.getElementById('check-hook-enabled');
  const selectHookModel = document.getElementById('select-hook-model');
  const resolutionSelector = document.getElementById('resolution-selector');
  const resDesc = document.getElementById('res-desc');
  const selectTtsVoice = document.getElementById('select-tts-voice');
  const inputCustomDir = document.getElementById('input-custom-dir');
  const btnSubmitProject = document.getElementById('btn-submit-project');
  const btnQueueOnly = document.getElementById('btn-queue-only');

  // Folder Picker Elements
  const btnBrowseFolder = document.getElementById('btn-browse-folder');
  const btnBrowseFolderInline = document.getElementById('btn-browse-folder-inline');
  const btnResetFolder = document.getElementById('btn-reset-folder');
  const btnClearCustomDir = document.getElementById('btn-clear-custom-dir');
  const folderModal = document.getElementById('folder-modal');
  const btnCloseFolderModal = document.getElementById('btn-close-folder-modal');
  const btnCancelFolderModal = document.getElementById('btn-cancel-folder-modal');
  const btnModalResetDefault = document.getElementById('btn-modal-reset-default');
  const btnOpenNativeFinder = document.getElementById('btn-open-native-finder');
  const btnOpenNativeFinderText = document.getElementById('btn-open-native-finder-text');
  const inputNewFolderName = document.getElementById('input-new-folder-name');
  const btnConfirmCreateFolder = document.getElementById('btn-confirm-create-folder');
  const folderCreateMsg = document.getElementById('folder-create-msg');
  const foldersList = document.getElementById('folders-list');
  const foldersCount = document.getElementById('folders-count');
  const btnRefreshFolderList = document.getElementById('btn-refresh-folder-list');

  // DOM Elements - Project Detail
  const projectDetailView = document.getElementById('project-detail-view');
  const detailTitle = document.getElementById('detail-title');
  const detailStatusBadge = document.getElementById('detail-status-badge');
  const metaCreated = document.getElementById('meta-created');
  const metaResolution = document.getElementById('meta-resolution');
  const metaHook = document.getElementById('meta-hook');
  const metaVoice = document.getElementById('meta-voice');
  const pipelineStepper = document.getElementById('pipeline-stepper');
  const terminalBody = document.getElementById('terminal-body');
  const checkAutoscroll = document.getElementById('check-autoscroll');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const btnRunActive = document.getElementById('btn-run-active');
  const btnStopActive = document.getElementById('btn-stop-active');
  const btnOpenActiveDir = document.getElementById('btn-open-active-dir');
  const btnDeleteActive = document.getElementById('btn-delete-active');

  // Media Inspector
  const mediaTabBtns = document.querySelectorAll('.media-tab-btn');
  const mediaTabPanes = document.querySelectorAll('.media-tab-pane');
  const videoPlaceholder = document.getElementById('video-placeholder');
  const playerVideo = document.getElementById('player-video');
  const audioPlaceholder = document.getElementById('audio-placeholder');
  const audioPlayerBox = document.getElementById('audio-player-box');
  const playerAudio = document.getElementById('player-audio');
  const visualsGallery = document.getElementById('visuals-gallery');
  const scriptViewerContent = document.getElementById('script-viewer-content');

  // Settings Modal
  const settingsModal = document.getElementById('settings-modal');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnCancelSettings = document.getElementById('btn-cancel-settings');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const cfgDefaultProfile = document.getElementById('cfg-default-profile');
  const cfgTtsVoice = document.getElementById('cfg-tts-voice');
  const cfgApiKeys = document.getElementById('cfg-api-keys');

  // -------------------------------------------------------------
  // INITIALIZATION
  // -------------------------------------------------------------
  fetchInitialData();
  initSSE();
  startStatusPolling();

  async function fetchInitialData() {
    try {
      const [stepsRes, projRes, statusRes] = await Promise.all([
        fetch('/api/steps'),
        fetch('/api/projects'),
        fetch('/api/status')
      ]);

      pipelineSteps = await stepsRes.json();
      projects = await projRes.json();
      const status = await statusRes.json();

      updateSystemStatus(status);
      renderProjectsList();

      if (projects.length > 0) {
        selectProject(projects[0].id);
      } else {
        showCreatorView();
      }
    } catch (e) {
      console.error('Failed to load initial data:', e);
    }
  }

  // -------------------------------------------------------------
  // REAL-TIME SSE (SERVER-SENT EVENTS)
  // -------------------------------------------------------------
  function initSSE() {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource('/api/stream');

    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleServerEvent(payload);
      } catch (e) {
        console.error('Error parsing SSE event:', e);
      }
    };

    eventSource.onerror = () => {
      setTimeout(initSSE, 3000);
    };
  }

  function handleServerEvent(event) {
    const { type, data } = event;

    if (type === 'init') {
      if (data.projects) {
        projects = data.projects;
        renderProjectsList();
      }
    } else if (type === 'project_created') {
      const existing = projects.findIndex(p => p.id === data.id);
      if (existing === -1) {
        projects.unshift(data);
      } else {
        projects[existing] = data;
      }
      renderProjectsList();
    } else if (type === 'project_status') {
      const idx = projects.findIndex(p => p.id === data.id);
      if (idx !== -1) {
        projects[idx] = data;
        renderProjectsList();
        if (currentProjectId === data.id) {
          updateDetailView(data);
        }
      }
    } else if (type === 'step_update') {
      const proj = projects.find(p => p.id === data.project_id);
      if (proj && proj.step_progress) {
        proj.step_progress[data.step_id] = {
          status: data.status,
          message: data.message,
          percent: data.percent
        };
        if (currentProjectId === proj.id) {
          renderStepper(proj);
        }
      }
    } else if (type === 'log') {
      if (currentProjectId === data.project_id) {
        appendLogLine(data);
      }
    } else if (type === 'project_deleted') {
      projects = projects.filter(p => p.id !== data.project_id);
      renderProjectsList();
      if (currentProjectId === data.project_id) {
        if (projects.length > 0) {
          selectProject(projects[0].id);
        } else {
          showCreatorView();
        }
      }
    }
  }

  // -------------------------------------------------------------
  // SYSTEM STATUS & DIAGNOSTICS
  // -------------------------------------------------------------
  function startStatusPolling() {
    setInterval(async () => {
      try {
        const res = await fetch('/api/status');
        const status = await res.json();
        updateSystemStatus(status);
      } catch (e) {}
    }, 4000);
  }

  function updateSystemStatus(status) {
    if (status.cdp_port_9222) {
      cdpDot.className = 'status-dot green pulse';
      cdpStatusPill.title = 'Chrome CDP Connected on Port 9222';
      btnLaunchCdp.style.display = 'none';
    } else {
      cdpDot.className = 'status-dot orange';
      cdpStatusPill.title = 'CDP port 9222 not detected. Click Start to launch Chrome.';
      btnLaunchCdp.style.display = 'inline-block';
    }

    if (status.api_keys_count > 0) {
      apiKeysCount.textContent = `${status.api_keys_count} Gemini Key${status.api_keys_count > 1 ? 's' : ''}`;
    } else {
      apiKeysCount.textContent = 'No API Keys';
    }
  }

  btnLaunchCdp.addEventListener('click', async (e) => {
    e.stopPropagation();
    btnLaunchCdp.textContent = 'Launching...';
    try {
      const res = await fetch('/api/system/launch-chrome', { method: 'POST' });
      const data = await res.json();
      updateSystemStatus(data.status);
    } catch (e) {
      alert('Could not launch Chrome automatically. Please run Chrome with --remote-debugging-port=9222');
    } finally {
      btnLaunchCdp.textContent = 'Start';
    }
  });

  // -------------------------------------------------------------
  // CREATOR FORM & BATCH CONTROLS
  // -------------------------------------------------------------
  tabSingleMode.addEventListener('click', () => {
    tabSingleMode.classList.add('active');
    tabBatchMode.classList.remove('active');
    groupSingleTopic.style.display = 'block';
    groupBatchTopics.style.display = 'none';
    document.getElementById('btn-submit-label').textContent = 'Start Automation Pipeline';
  });

  tabBatchMode.addEventListener('click', () => {
    tabBatchMode.classList.add('active');
    tabSingleMode.classList.remove('active');
    groupSingleTopic.style.display = 'none';
    groupBatchTopics.style.display = 'block';
    document.getElementById('btn-submit-label').textContent = 'Start Batch Pipeline Queue';
  });

  resolutionSelector.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      resolutionSelector.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedResolution = btn.getAttribute('data-res');
      if (selectedResolution === '2k') {
        resDesc.innerHTML = '<b>2K Ultra Quality</b>: Downloads crystal-clear 2K upscaled illustrations from Google Flow for sharp 1080p display.';
      } else {
        resDesc.innerHTML = '<b>1K Standard Quality</b>: Fast native resolution direct download from Google Flow.';
      }
    });
  });

  btnSubmitProject.addEventListener('click', () => submitProduction(true));
  btnQueueOnly.addEventListener('click', () => submitProduction(false));

  async function submitProduction(autoStart = true) {
    const isBatch = tabBatchMode.classList.contains('active');
    const hookEnabled = checkHookEnabled.checked;
    const hookModel = selectHookModel.value;
    const voice = selectTtsVoice.value;
    const customDir = inputCustomDir.value.trim();

    const settings = {
      resolution: selectedResolution,
      hook_enabled: hookEnabled,
      hook_model: hookModel,
      hook_count: 7,
      voice: voice
    };

    if (isBatch) {
      const rawText = inputBatchTopics.value.trim();
      const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 3);
      if (lines.length === 0) {
        alert('Please paste at least one video title.');
        return;
      }

      btnSubmitProject.disabled = true;
      try {
        const res = await fetch('/api/projects/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bulk_topics: lines,
            custom_dir: customDir,
            settings: settings,
            auto_start: autoStart
          })
        });
        const data = await res.json();
        if (data.success && data.created.length > 0) {
          inputBatchTopics.value = '';
          selectProject(data.created[0].id);
        }
      } catch (e) {
        alert('Error creating batch queue: ' + e);
      } finally {
        btnSubmitProject.disabled = false;
      }
    } else {
      const topic = inputTopic.value.trim();
      if (!topic) {
        alert('Please enter a video topic or title.');
        return;
      }

      btnSubmitProject.disabled = true;
      try {
        const res = await fetch('/api/projects/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: topic,
            custom_dir: customDir,
            settings: settings,
            auto_start: autoStart
          })
        });
        const data = await res.json();
        if (data.success && data.project) {
          inputTopic.value = '';
          selectProject(data.project.id);
        }
      } catch (e) {
        alert('Error creating project: ' + e);
      } finally {
        btnSubmitProject.disabled = false;
      }
    }
  }

  // -------------------------------------------------------------
  // SIDEBAR & PROJECT LIST RENDERING
  // -------------------------------------------------------------
  function renderProjectsList() {
    queueCount.textContent = projects.length;
    projectsList.innerHTML = '';

    if (projects.length === 0) {
      projectsList.appendChild(emptyQueueMsg);
      emptyQueueMsg.style.display = 'flex';
      return;
    }

    emptyQueueMsg.style.display = 'none';

    projects.forEach(p => {
      const item = document.createElement('div');
      item.className = `queue-item ${currentProjectId === p.id ? 'active' : ''}`;
      item.setAttribute('data-id', p.id);

      const statusClass = `status-${(p.status || 'queued').toLowerCase()}`;
      const timeStr = p.created_at ? new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

      // Calculate total progress
      let completedSteps = 0;
      if (p.step_progress) {
        Object.values(p.step_progress).forEach(s => {
          if (s.status === 'done') completedSteps++;
        });
      }
      const progressPercent = Math.round((completedSteps / 6) * 100);

      item.innerHTML = `
        <div class="queue-item-header">
          <span class="queue-status-tag ${statusClass}">${p.status || 'QUEUED'}</span>
          <span class="queue-time">${timeStr}</span>
        </div>
        <div class="queue-item-title">${escapeHtml(p.title || p.topic)}</div>
        <div class="queue-progress-bar">
          <div class="queue-progress-fill" style="width: ${progressPercent}%;"></div>
        </div>
      `;

      item.addEventListener('click', () => selectProject(p.id));
      projectsList.appendChild(item);
    });
  }

  btnShowCreator.addEventListener('click', () => {
    currentProjectId = null;
    showCreatorView();
    renderProjectsList();
  });

  function showCreatorView() {
    creatorView.style.display = 'block';
    projectDetailView.style.display = 'none';
  }

  function selectProject(projId) {
    currentProjectId = projId;
    const proj = projects.find(p => p.id === projId);
    if (!proj) return;

    creatorView.style.display = 'none';
    projectDetailView.style.display = 'block';

    renderProjectsList();
    updateDetailView(proj);
  }

  // -------------------------------------------------------------
  // DETAIL VIEW & PIPELINE STEPPER
  // -------------------------------------------------------------
  function updateDetailView(proj) {
    detailTitle.textContent = proj.title || proj.topic;

    const st = (proj.status || 'QUEUED').toUpperCase();
    detailStatusBadge.textContent = st;
    detailStatusBadge.className = `status-indicator-badge status-${st.toLowerCase()}`;

    const dateStr = proj.created_at ? new Date(proj.created_at).toLocaleString() : 'Just now';
    metaCreated.textContent = `Created: ${dateStr}`;

    const res = proj.settings?.resolution ? proj.settings.resolution.toUpperCase() : '2K';
    metaResolution.textContent = `${res} Resolution`;

    const hookModelName = proj.settings?.hook_model === 'omni_flash' ? 'Omni 1.1 Flash' : 'Veo 3.1 Lite';
    metaHook.textContent = proj.settings?.hook_enabled ? `${hookModelName} Hook` : 'No Hook Videos';

    metaVoice.textContent = `Voice: ${proj.settings?.voice || 'Leda'}`;

    renderStepper(proj);
    renderLogs(proj);
    renderMediaInspector(proj);
  }

  function renderStepper(proj) {
    pipelineStepper.innerHTML = '';
    const currentStepId = proj.current_step;

    pipelineSteps.forEach(step => {
      const stepState = (proj.step_progress && proj.step_progress[step.id]) || { status: 'pending', percent: 0 };
      const isCurrent = currentStepId === step.id && proj.status === 'RUNNING';
      const isDone = stepState.status === 'done';

      const card = document.createElement('div');
      card.className = `step-card ${isCurrent ? 'active' : ''} ${isDone ? 'done' : ''}`;

      const statusTagClass = `status-${stepState.status}`;
      card.innerHTML = `
        <div class="step-card-header">
          <span class="step-icon">${step.icon}</span>
          <span class="step-status-tag ${statusTagClass}">${stepState.status}</span>
        </div>
        <div class="step-title">${step.name}</div>
        <div class="step-desc">${stepState.message || step.desc}</div>
        <div class="step-progress-bar">
          <div class="step-progress-fill" style="width: ${stepState.percent || (isDone ? 100 : 0)}%;"></div>
        </div>
      `;

      pipelineStepper.appendChild(card);
    });
  }

  // -------------------------------------------------------------
  // TERMINAL & LOGS
  // -------------------------------------------------------------
  function renderLogs(proj) {
    terminalBody.innerHTML = '';
    const logs = proj.logs || [];
    if (logs.length === 0) {
      terminalBody.innerHTML = '<div class="log-line info">Waiting for pipeline execution...</div>';
      return;
    }

    logs.forEach(l => appendLogLine(l, false));
    scrollToBottom();
  }

  function appendLogLine(logData, autoScrollCheck = true) {
    const div = document.createElement('div');
    div.className = `log-line ${logData.level || 'info'}`;
    div.innerHTML = `<span class="log-time">[${logData.time}]</span>${escapeHtml(logData.text)}`;
    terminalBody.appendChild(div);

    if (autoScrollCheck && checkAutoscroll.checked) {
      scrollToBottom();
    }
  }

  function scrollToBottom() {
    terminalBody.scrollTop = terminalBody.scrollHeight;
  }

  btnClearLogs.addEventListener('click', () => {
    terminalBody.innerHTML = '';
  });

  // -------------------------------------------------------------
  // MEDIA INSPECTOR
  // -------------------------------------------------------------
  mediaTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      mediaTabBtns.forEach(b => b.classList.remove('active'));
      mediaTabPanes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      const pane = document.getElementById(tabId.replace('tab-', 'pane-'));
      if (pane) pane.classList.add('active');
    });
  });

  async function renderMediaInspector(proj) {
    const outputs = proj.output_files || {};

    // 1. Final Video Player
    if (outputs.final_video) {
      videoPlaceholder.style.display = 'none';
      playerVideo.style.display = 'block';
      const videoSrc = `/api/media/${proj.id}/final_video_1080p.mp4`;
      if (playerVideo.src !== window.location.origin + videoSrc) {
        playerVideo.src = videoSrc;
      }
    } else {
      videoPlaceholder.style.display = 'flex';
      playerVideo.style.display = 'none';
      playerVideo.pause();
    }

    // 2. Audio Player
    if (outputs.audio_mp3 || outputs.audio_wav) {
      audioPlaceholder.style.display = 'none';
      audioPlayerBox.style.display = 'block';
      const audioSrc = outputs.audio_mp3
        ? `/api/media/${proj.id}/final_voiceover.mp3`
        : `/api/media/${proj.id}/final_voiceover.wav`;

      if (playerAudio.src !== window.location.origin + audioSrc) {
        playerAudio.src = audioSrc;
      }
    } else {
      audioPlaceholder.style.display = 'flex';
      audioPlayerBox.style.display = 'none';
      playerAudio.pause();
    }

    // 3. Visuals Gallery (Clips & Images)
    renderVisualsGallery(proj);

    // 4. Script & Prompts
    renderScriptViewer(proj);
  }

  function renderVisualsGallery(proj) {
    visualsGallery.innerHTML = '';
    const hookCount = proj.output_files?.hook_videos_count || 0;
    const imgCount = proj.output_files?.images_count || 0;

    if (hookCount === 0 && imgCount === 0) {
      visualsGallery.innerHTML = '<p class="empty-gallery-msg">Generated 1-min video clips and 2.5D infographic images will appear here as each step completes.</p>';
      return;
    }

    // Render Hook Videos
    for (let i = 1; i <= Math.min(hookCount, 7); i++) {
      const pad = String(i).padStart(4, '0');
      const item = document.createElement('div');
      item.className = 'gallery-item';
      item.innerHTML = `
        <video src="/api/media/${proj.id}/${pad}.mp4" controls preload="metadata"></video>
        <div class="gallery-tag">🎥 Hook Clip #${i}</div>
      `;
      visualsGallery.appendChild(item);
    }

    // Render 1K/2K Images
    for (let i = 1; i <= Math.min(imgCount, 12); i++) {
      const pad = String(i).padStart(4, '0');
      const item = document.createElement('div');
      item.className = 'gallery-item';
      item.innerHTML = `
        <img src="/api/media/${proj.id}/${pad}.jpg" loading="lazy" alt="Scene ${i}">
        <div class="gallery-tag">🖼️ Image #${i}</div>
      `;
      visualsGallery.appendChild(item);
    }
  }

  async function renderScriptViewer(proj) {
    if (proj.output_files?.narration) {
      try {
        const res = await fetch(`/api/media/${proj.id}/narration_only.txt`);
        const text = await res.text();
        scriptViewerContent.textContent = text;
        return;
      } catch (e) {}
    }

    if (proj.output_files?.script) {
      try {
        const res = await fetch(`/api/media/${proj.id}/generated_gemini_script.txt`);
        const text = await res.text();
        scriptViewerContent.textContent = text;
        return;
      } catch (e) {}
    }

    scriptViewerContent.innerHTML = '<p class="empty-script-msg">Generated Gemini Pro script and narration prompts will appear here.</p>';
  }

  // -------------------------------------------------------------
  // DETAIL ACTIONS (RUN, STOP, FINDER, DELETE)
  // -------------------------------------------------------------
  btnRunActive.addEventListener('click', async () => {
    if (!currentProjectId) return;
    try {
      await fetch(`/api/projects/${currentProjectId}/run`, { method: 'POST' });
    } catch (e) {
      alert('Failed to start pipeline: ' + e);
    }
  });

  btnStopActive.addEventListener('click', async () => {
    try {
      await fetch('/api/cancel', { method: 'POST' });
    } catch (e) {
      alert('Failed to stop pipeline: ' + e);
    }
  });

  btnOpenActiveDir.addEventListener('click', async () => {
    const proj = projects.find(p => p.id === currentProjectId);
    if (!proj || !proj.project_dir) return;

    try {
      await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: proj.project_dir })
      });
    } catch (e) {
      alert('Could not open folder in Finder: ' + e);
    }
  });

  btnDeleteActive.addEventListener('click', async () => {
    if (!currentProjectId) return;
    if (!confirm('Are you sure you want to delete this project?')) return;

    try {
      await fetch(`/api/projects/${currentProjectId}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete_files: false })
      });
    } catch (e) {
      alert('Failed to delete project: ' + e);
    }
  });

  // -------------------------------------------------------------
  // SETTINGS MODAL
  // -------------------------------------------------------------
  btnOpenSettings.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      cfgDefaultProfile.value = cfg.default_profile || 'Menaka Gemini Pro';
      cfgTtsVoice.value = cfg.tts_voice || 'Leda';
      const keys = cfg.gemini_api_keys || (cfg.gemini_api_key ? [cfg.gemini_api_key] : []);
      cfgApiKeys.value = keys.join('\n');
    } catch (e) {}
    settingsModal.style.display = 'flex';
  });

  btnCloseSettings.addEventListener('click', () => { settingsModal.style.display = 'none'; });
  btnCancelSettings.addEventListener('click', () => { settingsModal.style.display = 'none'; });

  btnSaveSettings.addEventListener('click', async () => {
    const rawKeys = cfgApiKeys.value.split('\n').map(k => k.trim()).filter(k => k.length > 10);
    const payload = {
      default_profile: cfgDefaultProfile.value.trim(),
      tts_voice: cfgTtsVoice.value,
      gemini_api_keys: rawKeys,
      gemini_api_key: rawKeys[0] || ''
    };

    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      settingsModal.style.display = 'none';
      alert('Settings saved successfully!');
    } catch (e) {
      alert('Error saving settings: ' + e);
    }
  });

  // -------------------------------------------------------------
  // FOLDER BROWSER & CREATOR MODAL
  // -------------------------------------------------------------
  function updateClearBtnVisibility() {
    if (btnClearCustomDir) {
      btnClearCustomDir.style.display = inputCustomDir.value.trim() ? 'block' : 'none';
    }
  }

  inputCustomDir.addEventListener('input', updateClearBtnVisibility);

  if (btnClearCustomDir) {
    btnClearCustomDir.addEventListener('click', () => {
      inputCustomDir.value = '';
      updateClearBtnVisibility();
    });
  }

  if (btnResetFolder) {
    btnResetFolder.addEventListener('click', () => {
      inputCustomDir.value = '';
      updateClearBtnVisibility();
    });
  }

  function openFolderModal() {
    folderModal.style.display = 'flex';
    folderCreateMsg.textContent = '';
    folderCreateMsg.className = 'folder-action-msg';
    inputNewFolderName.value = '';
    loadExistingFolders();
  }

  function closeFolderModal() {
    folderModal.style.display = 'none';
  }

  // Direct Native macOS Finder Browse
  async function triggerNativeBrowse() {
    if (btnBrowseFolderInline) {
      btnBrowseFolderInline.disabled = true;
      btnBrowseFolderInline.innerHTML = '<span>⏳ Opening...</span>';
    }
    try {
      const res = await fetch('/api/browse-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initial_dir: inputCustomDir.value.trim() })
      });
      const data = await res.json();
      if (data.success && data.path) {
        inputCustomDir.value = data.path;
        updateClearBtnVisibility();
      }
    } catch (e) {
      console.error('Error opening Finder picker:', e);
      openFolderModal();
    } finally {
      if (btnBrowseFolderInline) {
        btnBrowseFolderInline.disabled = false;
        btnBrowseFolderInline.innerHTML = '<span>📂 Browse...</span>';
      }
    }
  }

  if (btnBrowseFolderInline) btnBrowseFolderInline.addEventListener('click', triggerNativeBrowse);
  if (btnBrowseFolder) btnBrowseFolder.addEventListener('click', openFolderModal);
  if (btnCloseFolderModal) btnCloseFolderModal.addEventListener('click', closeFolderModal);
  if (btnCancelFolderModal) btnCancelFolderModal.addEventListener('click', closeFolderModal);

  if (btnModalResetDefault) {
    btnModalResetDefault.addEventListener('click', () => {
      inputCustomDir.value = '';
      updateClearBtnVisibility();
      closeFolderModal();
    });
  }

  // Load existing project folders
  async function loadExistingFolders() {
    if (!foldersList) return;
    foldersList.innerHTML = '<div class="folders-loading">Loading project folders...</div>';
    try {
      const res = await fetch('/api/folders');
      const data = await res.json();
      const list = data.folders || [];
      if (foldersCount) foldersCount.textContent = list.length;

      if (list.length === 0) {
        foldersList.innerHTML = '<div class="folders-empty">No folders in projects/ yet. Create one above!</div>';
        return;
      }

      const currentPath = inputCustomDir.value.trim();
      foldersList.innerHTML = '';
      list.forEach(f => {
        const isCurrent = currentPath === f.path || currentPath.endsWith(f.name);
        const item = document.createElement('div');
        item.className = `folder-list-item ${isCurrent ? 'selected' : ''}`;
        item.innerHTML = `
          <div class="folder-item-info">
            <div class="folder-item-header">
              <span class="folder-item-name">📁 ${escapeHtml(f.name)}</span>
              ${isCurrent ? '<span class="folder-badge-active">Selected</span>' : ''}
            </div>
            <div class="folder-item-meta">${escapeHtml(f.mtime_str || '')} • ${escapeHtml(f.path)}</div>
          </div>
          <button class="folder-item-select-btn" type="button">${isCurrent ? 'Active' : 'Select'}</button>
        `;

        item.addEventListener('click', () => {
          inputCustomDir.value = f.path;
          updateClearBtnVisibility();
          closeFolderModal();
        });

        foldersList.appendChild(item);
      });
    } catch (e) {
      foldersList.innerHTML = `<div class="folders-empty">Error loading folders: ${escapeHtml(e.message)}</div>`;
    }
  }

  if (btnRefreshFolderList) {
    btnRefreshFolderList.addEventListener('click', loadExistingFolders);
  }

  // Native macOS Finder Picker
  if (btnOpenNativeFinder) {
    btnOpenNativeFinder.addEventListener('click', async () => {
      btnOpenNativeFinder.disabled = true;
      if (btnOpenNativeFinderText) btnOpenNativeFinderText.textContent = 'Waiting for Finder...';
      try {
        const res = await fetch('/api/browse-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initial_dir: inputCustomDir.value.trim() })
        });
        const data = await res.json();
        if (data.success && data.path) {
          inputCustomDir.value = data.path;
          updateClearBtnVisibility();
          closeFolderModal();
        }
      } catch (e) {
        alert('Error opening Finder picker: ' + e);
      } finally {
        btnOpenNativeFinder.disabled = false;
        if (btnOpenNativeFinderText) btnOpenNativeFinderText.textContent = 'Open Finder';
      }
    });
  }

  // Create New Folder
  async function handleCreateFolder() {
    const name = inputNewFolderName.value.trim();
    if (!name) {
      folderCreateMsg.textContent = '⚠️ Please enter a folder name.';
      folderCreateMsg.className = 'folder-action-msg error';
      return;
    }

    btnConfirmCreateFolder.disabled = true;
    folderCreateMsg.textContent = 'Creating folder...';
    folderCreateMsg.className = 'folder-action-msg';

    try {
      const res = await fetch('/api/folders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
      });
      const data = await res.json();
      if (data.success && data.path) {
        folderCreateMsg.textContent = `✅ Folder created: ${data.name}`;
        folderCreateMsg.className = 'folder-action-msg success';
        inputCustomDir.value = data.path;
        updateClearBtnVisibility();
        await loadExistingFolders();
        setTimeout(() => {
          closeFolderModal();
        }, 600);
      } else {
        folderCreateMsg.textContent = `❌ ${data.error || 'Failed to create folder'}`;
        folderCreateMsg.className = 'folder-action-msg error';
      }
    } catch (e) {
      folderCreateMsg.textContent = `❌ Error: ${e.message}`;
      folderCreateMsg.className = 'folder-action-msg error';
    } finally {
      btnConfirmCreateFolder.disabled = false;
    }
  }

  if (btnConfirmCreateFolder) {
    btnConfirmCreateFolder.addEventListener('click', handleCreateFolder);
  }
  if (inputNewFolderName) {
    inputNewFolderName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCreateFolder();
      }
    });
  }

  // Helper
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
});
