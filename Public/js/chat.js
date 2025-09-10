// Public/js/chat.js
(() => {
  const socket = io({ withCredentials: true });
  const $list = document.getElementById('chat-list');
  const $form = document.getElementById('chat-form');
  const $input = document.getElementById('chat-input');
  const $etab = document.getElementById('chat-etab');

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));

  function addBubble(msg, meId){
    const mine = msg?.auteur?.id === meId;
    const li = document.createElement('li');
    li.className = 'bubble ' + (mine ? 'me' : 'them');
    li.innerHTML = `
      <div class="meta">
        <span class="name">${esc(msg?.auteur?.nom || '—')}</span>
        <span class="time">${new Date(msg.createdAt).toLocaleTimeString()}</span>
      </div>
      <div class="text">${esc(msg.texte)}</div>
    `;
    $list.appendChild(li);
    $list.parentElement.scrollTop = $list.parentElement.scrollHeight;
  }

  let me = null;

  socket.on('chat:ready', (info) => {
    me = info.you;
    // charge un petit historique initial
    socket.emit('chat:history', { limit: 50, etablissement: $etab?.value || '' });
  });

  socket.on('chat:history', (rows) => {
    $list.innerHTML = '';
    rows.forEach(m => addBubble({
      ...m,
      auteur: { id: m.auteurId, nom: m.auteurNom, role: m.auteurRole, etab: m.etablissement }
    }, me?.id));
  });

  socket.on('chat:new', (msg) => addBubble(msg, me?.id));
  socket.on('chat:error', (e) => console.warn('Chat error:', e));

  $form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = ($input.value || '').trim();
    if (!text) return;
    socket.emit('chat:send', { text, etablissement: $etab?.value || '' });
    $input.value = '';
  });
})();
