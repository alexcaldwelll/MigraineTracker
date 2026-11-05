// The data layer. Every screen goes through data(), never Supabase directly.
// Backend methods reject when an operation fails; screens decide what to show.

const PAGE_SIZE = 1000;

let backend = null;

export function setBackend(next){ backend = next; }

export function data(){
  if(!backend) throw new Error('No data backend has been set.');
  return backend;
}

// For screens that show an empty list when a read fails.
export function emptyOnError(list){
  return list.catch(error=>{ console.error(error); return []; });
}

const rowToEntry = row => ({ id: row.id, type: row.type, time: row.time, ...row.data });

function entryToRow(date, entry){
  const { type, time, ...data } = entry;
  return { date, time, type, data };
}

// Supabase returns { data, error }, where error may be a plain object. This
// unwraps data and rejects with a real Error that keeps Supabase's details.
async function run(query){
  const { data, error } = await query;
  if(error) throw Object.assign(new Error(error.message), error);
  return data;
}

export function createSupabaseBackend(client){
  return {
    async listDay(date){
      const rows = await run(client.from('entries').select('*').eq('date', date).order('time', {ascending:true}));
      return rows.map(rowToEntry);
    },

    // Every entry, grouped by date, newest date first:
    // [{date, entries: [{id, type, time, ...data}]}]
    async listAll(){
      const byDate = new Map();
      for(let from = 0; ; from += PAGE_SIZE){
        // Sorting ends on id so pages cannot overlap or skip.
        const page = await run(client.from('entries').select('*')
          .order('date', {ascending:false})
          .order('time', {ascending:true})
          .order('id', {ascending:true})
          .range(from, from + PAGE_SIZE - 1));
        page.forEach(row=>{
          if(!byDate.has(row.date)) byDate.set(row.date, []);
          byDate.get(row.date).push(rowToEntry(row));
        });
        if(page.length < PAGE_SIZE) break;
      }
      return Array.from(byDate, ([date, entries])=>({date, entries}));
    },

    // Returns the new row's id (null if the store did not give one back).
    async add(date, entry){
      const row = await run(client.from('entries').insert(entryToRow(date, entry)).select('id').single());
      return row?.id ?? null;
    },
    async update(id, date, entry){
      await run(client.from('entries').update(entryToRow(date, entry)).eq('id', id));
    },
    async remove(id){
      await run(client.from('entries').delete().eq('id', id));
    },

    // A med is { name, category, default_dose }, plus id and created_at once stored.
    listMeds(){
      return run(client.from('meds_catalog').select('*').order('created_at', {ascending:true}));
    },
    async addMed(med){
      await run(client.from('meds_catalog').insert(med));
    },
    async removeMed(id){
      await run(client.from('meds_catalog').delete().eq('id', id));
    },

    // Returns the person's settings row, or null if they have none yet.
    getSettings(){
      return run(client.from('user_settings').select('*').maybeSingle());
    },
    // Only the columns in patch change.
    async saveSettings(patch){
      await run(client.from('user_settings').upsert(patch));
    },

    // Returns { result, created_at }, or null if nothing has been saved yet.
    getInsight(){
      return run(client.from('insights').select('result, created_at').maybeSingle());
    },
    // One saved insight per person; a new one replaces the last.
    async saveInsight(result){
      await run(client.from('insights').upsert({ result, created_at: new Date().toISOString() }));
    },

    listTrials(){
      return run(client.from('trials').select('*').order('created_at', {ascending:false}));
    },
    // Inserts a trial with no id and updates one with an id. Returns the stored row.
    saveTrial(trial){
      return run(client.from('trials').upsert(trial).select().single());
    },

    async ai(action, payload){
      const send = (token)=> fetch('/.netlify/functions/ai', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token},
        body: JSON.stringify({ action, payload })
      });
      const { data: { session } } = await client.auth.getSession();
      if(!session) throw new Error('Please sign in again.');
      let response = await send(session.access_token);
      if(response.status === 401){
        const { data, error } = await client.auth.refreshSession();
        if(error || !data.session) throw new Error('Please sign in again.');
        response = await send(data.session.access_token);
      }
      const body = await response.json().catch(()=> null);
      if(!response.ok){
        const error = new Error((body && body.error) || 'The AI service is unavailable. Try again later.');
        error.status = response.status;
        throw error;
      }
      return body;
    },
  };
}
