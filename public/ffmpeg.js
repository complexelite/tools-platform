const form = document.querySelector('#convert-form');
const fileInput = document.querySelector('#media-file');
const presetInput = document.querySelector('#preset');
const button = document.querySelector('#convert-button');
const status = document.querySelector('#conversion-status');
const progress = document.querySelector('#conversion-progress');

form.addEventListener('submit', event => {
  event.preventDefault();
  const file = fileInput.files?.[0];
  if (!file) {
    status.textContent = 'Choose a media file to continue.';
    return;
  }
  if (file.size > 500 * 1024 * 1024) {
    status.textContent = 'This file is larger than the 500 MB upload limit.';
    return;
  }

  button.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  status.textContent = 'Uploading your file…';

  const request = new XMLHttpRequest();
  request.open('POST', `/api/ffmpeg/convert?preset=${encodeURIComponent(presetInput.value)}`);
  request.responseType = 'blob';
  request.setRequestHeader('Content-Type', 'application/octet-stream');
  request.upload.onprogress = event => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    progress.value = percent;
    status.textContent = percent < 100 ? `Uploading your file… ${percent}%` : 'Converting on the server…';
  };
  request.onload = async () => {
    button.disabled = false;
    if (request.status < 200 || request.status >= 300) {
      let message = 'Conversion failed. Check the file and selected output format.';
      try { message = JSON.parse(await request.response.text()).error || message; } catch {}
      status.textContent = message;
      return;
    }
    const output = URL.createObjectURL(request.response);
    const link = document.createElement('a');
    link.href = output;
    link.download = `converted.${presetInput.value}`;
    link.click();
    URL.revokeObjectURL(output);
    status.textContent = 'Conversion complete. Your download has started.';
  };
  request.onerror = () => {
    button.disabled = false;
    status.textContent = 'Could not reach the conversion service. Retry shortly.';
  };
  request.onabort = () => {
    button.disabled = false;
    status.textContent = 'Upload cancelled.';
  };
  request.send(file);
});
