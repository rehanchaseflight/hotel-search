const db=require('./db');
(async()=>{
  try{
    await db.init();
    const r=await db.query('SELECT id,username,role,created_at FROM staff ORDER BY id');
    console.table(r.rows);
  }catch(e){
    console.error(e.message);
    process.exitCode=1;
  }
})();
