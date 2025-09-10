/* ========================================================================
 *  inspector.js – tableau de bord Inspecteur
 * ------------------------------------------------------------------------
 *  • Liste brute des dépôts          (/api/summary/list)
 *  • Ratios globaux par dépôt        (calculés serveur, même route)
 *  • Synthèse par classe             (/api/summary)
 *  • Synthèse « Totaux globaux »
 *  • En-tête identique à la feuille animateur
 * ===================================================================== */

document.addEventListener('DOMContentLoaded', () => {

  /* Références DOM -------------------------------------------------- */
  const selCycle = document.getElementById('selCycle');
  const selSpec  = document.getElementById('selSpec');
  const selEval  = document.getElementById('selEval');
  const lstDep   = document.getElementById('listeDepots');
  const tblStats = document.getElementById('tblStats');
  const result   = document.getElementById('result');

  if(!selCycle || !selSpec || !selEval || !lstDep || !tblStats || !result){
    console.error('🔥  inspector.js : éléments DOM manquants'); return;
  }

  /* Rafraîchissement au changement de sélecteur -------------------- */
  [selCycle, selSpec, selEval].forEach(el => el.addEventListener('change', reload));
  reload();                                     // 1er chargement

  /* =================================================================
   *  Fonction principale
   * =============================================================== */
  async function reload(){
    const cycle = selCycle.value.trim();
    const spec  = selSpec.value.trim();
    const eva   = selEval.value.trim();              // '', 1-6 ou T1-T3

    /* Aucun critère ⇒ on vide tout l’écran */
    if(!cycle || !spec){
      lstDep.innerHTML  = '';
      tblStats.innerHTML= '';
      result.innerHTML  = '';
      return;
    }

    /* Construction QS sécurisée ----------------------------------- */
    const qs = new URLSearchParams({ cycle, specialite: spec });
    if(eva){
      if(eva.startsWith('T')) qs.append('trimestre', eva.slice(1)); // T1→1 …
      else                    qs.append('evaluation', eva);         // 1…6
    }

    /* 1-a. Liste brute des dépôts --------------------------------- */
    lstDep.innerHTML = '<li>Chargement…</li>';
    try{
      const dep = await fetch('/api/summary/list?'+qs,
                              { credentials:'same-origin' })
                     .then(r => r.ok ? r.json()
                                     : Promise.reject(r.statusText));

      lstDep.innerHTML = dep.length
        ? dep.map(d =>
            `<li>${d.etablissement} — ${d.animateur} (Éva ${d.evaluation})</li>`
          ).join('')
        : '<li>Aucun dépôt pour ces critères.</li>';
    }catch(err){
      console.error(err);
      lstDep.innerHTML = `<li style="color:red">Erreur liste : ${err}</li>`;
    }

    /* 1-bis. Situation dépôt par dépôt ---------------------------- */
    await renderDepotStats(qs.toString());

    /* 2. Synthèses agrégées --------------------------------------- */
    result.innerHTML = '<p>Chargement…</p>';
    try{
      const data = await fetch('/api/summary?'+qs,
                               { credentials:'same-origin' })
                     .then(r => r.ok ? r.json()
                                     : Promise.reject(r.statusText));

      if(!data.length){
        result.innerHTML = '<p>Aucune donnée (0 dépôt).</p>';
        return;
      }

      const global = buildGlobalTotals(data);
      result.innerHTML =
        renderGlobal(global) +
        data.map(renderClasse).join('');
    }catch(err){
      console.error(err);
      result.innerHTML = `<p style="color:red">Erreur synthèse : ${err}</p>`;
    }
  }

  /* -----------------------------------------------------------------
   *  1-bis. Situation dépôt par dépôt = tableau des ratios
   * ----------------------------------------------------------------*/
 async function renderDepotStats(qs){
  tblStats.innerHTML = '<p>Calcul…</p>';

  try{
    /* le back-end renvoie déjà : H, Pc, Pd, Tc, Td, R, A */
    const stats = await fetch('/api/summary/list?'+qs,
                              { credentials:'same-origin' })
                   .then(r => r.ok ? r.json()
                                   : Promise.reject(r.statusText));

    if(!stats.length){
      tblStats.innerHTML = '<p>Aucun dépôt pour ces critères.</p>';
      return;
    }

    /* ─── tableau HTML ─── */
    tblStats.innerHTML = `
      <table>
        <thead>
          <tr>
            <th rowspan="2">Établissement&nbsp;/&nbsp;Animateur</th>
            <th colspan="7">Indicateurs agrégés du dépôt</th>
          </tr>
          <tr>
            <th>Couverture&nbsp;heures&nbsp;%</th>
            <th>Prog.&nbsp;classique&nbsp;%</th>
            <th>Prog.&nbsp;digitalisé&nbsp;%</th>
            <th>TP&nbsp;classique&nbsp;%</th>
            <th>TP&nbsp;digitalisé&nbsp;%</th>
            <th>Taux&nbsp;réussite&nbsp;%</th>
            <th>Taux&nbsp;assiduité&nbsp;%</th>
          </tr>
        </thead>
        <tbody>
          ${stats.map(d => `
            <tr>
              <td>${d.etablissement} — ${d.animateur} (Éva&nbsp;${d.evaluation})</td>
              <td>${fmt(d.H )}</td>
              <td>${fmt(d.Pc)}</td><td>${fmt(d.Pd)}</td>
              <td>${fmt(d.Tc)}</td><td>${fmt(d.Td)}</td>
              <td>${fmt(d.R )}</td><td>${fmt(d.A )}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    /* helper : affiche « — » si 0 / indéfini */
    function fmt(v){ return v ? v.toFixed(1)+' %' : '—'; }

  }catch(err){
    console.error(err);
    tblStats.innerHTML = `<p style="color:red">Erreur stats : ${err}</p>`;
  }
}
  /* -----------------------------------------------------------------
   * 3. Construction des totaux globaux (toutes classes)
   * ----------------------------------------------------------------*/
  function buildGlobalTotals(all){
    const agg = {};
    all.forEach(cl =>
      cl.disciplines.forEach(d => {
        const a = agg[d.nom] ||= {
          hD:0,hF:0, lp:0,lf:0, ldp:0,ldf:0,
          tp:0,tf:0, tdp:0,tdf:0,
          comp:0,m10:0, effT:0,effP:0
        };
        Object.keys(a).forEach(k => a[k] += d[k] || 0);
      })
    );
    return Object.entries(agg).map(([nom,vals]) => ({ nom, ...vals }));
  }

  /* -----------------------------------------------------------------
   *  Helpers de rendu (identiques à l’animateur)
   * ----------------------------------------------------------------*/
  function renderGlobal(list){
    return `
      <h3 class="classTitle" style="background:#dfe;border-left:6px solid #4a4">
        🔎 Totaux globaux (toutes classes)
      </h3>
      <table>
        <thead>${thead()}</thead>
        <tbody>
          ${list.map(renderRow).join('')}
          ${subtotalRow(list,true)}
        </tbody>
      </table>`;
  }

  function renderClasse(c){
    return `
      <h3 class="classTitle">${c.classe}</h3>
      <table>
        <thead>${thead()}</thead>
        <tbody>
          ${c.disciplines.map(renderRow).join('')}
          ${subtotalRow(c.disciplines)}
        </tbody>
      </table>`;
  }

  function thead(){
    return `<tr>
      <th rowspan="2">Module / Discipline</th>
      <th colspan="3">Couverture des heures</th>
      <th colspan="6">Couverture des programmes</th>
      <th colspan="6">Réalisation des TP</th>
      <th colspan="3">Réussite des élèves</th>
      <th colspan="3">Assiduité et ponctualité des enseignants</th>
    </tr>
    <tr>
      <th>Heures dues</th><th>Heures faites</th><th>%</th>
      <th>Leçons prévues</th><th>Faites</th><th>%</th>
      <th>Leçons dig. prév.</th><th>Faites</th><th>%</th>
      <th>TP prévus</th><th>Faits</th><th>%</th>
      <th>TP dig. prév.</th><th>Faits</th><th>%</th>
      <th>Élèves comp.</th><th>≥10/20</th><th>%</th>
      <th>Effectif</th><th>En poste</th><th>%</th>
    </tr>`;
  }

  const pctCell = (t,f)=>
    !t ? '<td></td>' :
    `<td${100*f/t>100 ? ' style="color:#c42"' : ''}>${Math.round(100*f/t)}%</td>`;

  const cells = (t,f)=>`<td>${t||''}</td><td>${f||''}</td>${pctCell(t,f)}`;

  function renderRow(d){
    return `<tr>
      <td>${d.nom}</td>
      ${cells(d.hD ,d.hF )}${cells(d.lp ,d.lf )}${cells(d.ldp,d.ldf)}
      ${cells(d.tp ,d.tf )}${cells(d.tdp,d.tdf)}
      ${cells(d.comp,d.m10)}${cells(d.effT,d.effP)}
    </tr>`;
  }

  function subtotalRow(list, head=false){
    if(!list.length) return '';
    const sum = {}; Object.keys(list[0]).forEach(k => sum[k]=0);
    list.forEach(d => Object.keys(sum).forEach(k => sum[k] += +d[k]||0));
    return `<tr style="font-weight:600;${head?'background:#cdf':''}">
      <td>${head ? 'Total global' : 'Sous-total'}</td>
      ${cells(sum.hD ,sum.hF )}${cells(sum.lp ,sum.lf )}${cells(sum.ldp,sum.ldf)}
      ${cells(sum.tp ,sum.tf )}${cells(sum.tdp,sum.tdf)}
      ${cells(sum.comp,sum.m10)}${cells(sum.effT,sum.effP)}
    </tr>`;
  }
});
