import importlib.util
import pathlib
import unittest

spec=importlib.util.spec_from_file_location('sync_auth',pathlib.Path(__file__).resolve().parents[1]/'deploy'/'sync-sub2api-auth.py')
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)

class ExporterTest(unittest.TestCase):
    def setUp(self):
        self.cfg={'container':'sub2api-postgres','database':'sub2api','db_user':'sub2api','account_ids':[1],'api_key_ids':[1],'log_salt':'a'*64}
        self.now=1800000000000
        self.account={'id':1,'platform':'openai','type':'oauth','status':'active','schedulable':True,'token':'synthetic-access','account_id':'synthetic-account','expires_at':(self.now+3600000)/1000}
        self.client={'id':1,'group_id':2,'key':'synthetic-key','expires_at':None,'account_id':1}
    def result(self):
        return sync.sanitize({'accounts':[self.account],'clients':[self.client]},self.cfg,self.now)
    def test_expiry_formats(self):
        for value in [1800000000,'1800000000',1800000000000,'1800000000000']:
            self.assertEqual(sync.epoch_ms(value),1800000000000)
        self.assertEqual(sync.epoch_ms('2027-01-15T08:00:00+00:00'),1800000000000)
        for value in ['',None,'garbage','nan','Infinity',-1]:self.assertIsNone(sync.epoch_ms(value))
    def test_only_approved_fields_and_hashed_client(self):
        self.account['refresh_token']='NEVER_EXPORT';self.account['unrelated']='NEVER_EXPORT'
        r=self.result();self.assertEqual(r[0]['token'],'synthetic-access');self.assertEqual(r[0]['expiresAt'],self.now+3600000)
        text=sync.json.dumps(r);self.assertNotIn('NEVER_EXPORT',text);self.assertNotIn('synthetic-key',text);self.assertEqual(len(r[0]['clients'][0]['hash']),64)
    def test_account_allowlist(self):
        self.account['id']=2;self.assertEqual(self.result(),[])
    def test_key_allowlist(self):
        self.client['id']=2;self.assertEqual(self.result()[0]['clients'],[])
    def test_account_disabled_and_expired(self):
        self.account['status']='disabled';self.assertIsNone(self.result()[0]['token'])
        self.account['status']='active';self.account['expires_at']=self.now/1000;self.assertIsNone(self.result()[0]['token'])
    def test_expired_or_malformed_key_expiry(self):
        self.client['expires_at']='garbage';self.assertEqual(self.result()[0]['clients'],[])
        self.client['expires_at']='2020-01-01T00:00:00Z';self.assertEqual(self.result()[0]['clients'],[])
    def test_query_cannot_export_refresh_or_arbitrary_credentials(self):
        sql=sync.query_sql(self.cfg);self.assertIn('BEGIN READ ONLY;',sql);self.assertNotIn('refresh_token',sql)
        self.assertNotIn('SELECT *',sql);self.assertIn('k.id IN (1)',sql);self.assertIn("u.status='active'",sql)
    def test_invalid_root_config_is_rejected(self):
        for field,value in [('account_ids',['1; DROP TABLE accounts']),('account_ids',[True]),('container','-H attacker'),('database','db;stuff'),('log_salt','bad')]:
            config=dict(self.cfg);config[field]=value
            with self.assertRaises(ValueError):sync.validate_config(config)

if __name__=='__main__':unittest.main()
