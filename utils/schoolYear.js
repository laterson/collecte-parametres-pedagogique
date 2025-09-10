module.exports = function computeSchoolYear(d = new Date()){
  const y = d.getFullYear(), m = d.getMonth(); // 0=janv … 11=déc
  return (m >= 7) ? `${y}-${y+1}` : `${y-1}-${y}`;
};
