import pandas as pd, numpy as np, json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data' / 'ibm_accounts_receivable.csv'
OUT = ROOT / 'results'
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score, accuracy_score, precision_score, recall_score
from sklearn.preprocessing import StandardScaler
np.random.seed(0)
df=pd.read_csv(DATA, dtype={'customerID':str,'invoiceNumber':str})
for c in ['PaperlessDate','InvoiceDate','DueDate','SettledDate']: df[c]=pd.to_datetime(df[c], format='%m/%d/%Y')
df['late']=(df.DaysLate>0).astype(int)
df['elec']=(df.PaperlessBill=='Electronic').astype(int)
df['disp']=(df.Disputed=='Yes').astype(int)
COUNTRIES=sorted(df.countryCode.unique())
PRIOR=None
K=3.0  # lissage
import sys
WITH_COUNTRY = len(sys.argv)>1 and sys.argv[1]=='country'
H = 7

def feats(rows, t_col):
    """rows: invoices with a column t (reference time). History = same customer, SettledDate < t."""
    out=[]
    by=df.groupby('customerID')
    for _,r in rows.iterrows():
        t=r[t_col]; h=by.get_group(r.customerID); h=h[h.SettledDate<t]
        n=len(h); late=h.late.sum()
        o=h  # 
        op=df[(df.customerID==r.customerID)&(df.InvoiceDate<=t)&(df.SettledDate>=t)&(df.invoiceNumber!=r.invoiceNumber)]
        out.append(dict(
          hist_n=np.log1p(n),
          hist_late_rate=(late+K*PRIOR)/(n+K),
          hist_mean_dayslate=(h.DaysLate.sum()+K*PRIOR_DL)/(n+K),
          hist_disp_rate=(h.disp.sum()+K*PRIOR_DISP)/(n+K),
          last_late=(h.sort_values('SettledDate').late.iloc[-1] if n else PRIOR),
          log_amount=np.log(r.InvoiceAmount),
          amount_vs_cust=(r.InvoiceAmount/h.InvoiceAmount.mean() if n else 1.0),
          elec=r.elec,
          open_others=len(op),
          **({f'c_{c}':int(r.countryCode==c) for c in COUNTRIES} if WITH_COUNTRY else {})))
    return pd.DataFrame(out, index=rows.index)
FEATS=None
CUTOFF=pd.Timestamp('2013-07-01'); SAFE=76
def fit(cut):
    global PRIOR, PRIOR_DL, PRIOR_DISP
    tr=df[df.InvoiceDate< cut-pd.Timedelta(days=SAFE)].copy()
    PRIOR=tr.late.mean(); PRIOR_DL=tr.DaysLate.mean(); PRIOR_DISP=tr.disp.mean()
    tr['t']=tr.InvoiceDate
    X=feats(tr,'t'); y=tr.late
    return tr,X,y
tr,Xtr,ytr=fit(CUTOFF)
FEATS=list(Xtr.columns)
print('train n',len(tr),'late',ytr.mean().round(3),'priors',round(PRIOR,3))
sc=StandardScaler().fit(Xtr)
lr=LogisticRegression(C=1.0,max_iter=2000).fit(sc.transform(Xtr),ytr)
gb=HistGradientBoostingClassifier(max_depth=3,learning_rate=0.05,max_iter=300,random_state=0).fit(Xtr,ytr)

# --- évaluation "classification" : factures émises après le cutoff, variables à la date d'émission
te=df[df.InvoiceDate>=CUTOFF].copy(); te['t']=te.InvoiceDate
Xte=feats(te,'t'); yte=te.late
res={}
for name,m,X in [('Régression logistique',lr,sc.transform(Xte)),('Gradient boosting',gb,Xte)]:
    p=m.predict_proba(X)[:,1]; pr=(p>=0.5).astype(int)
    res[name]=dict(auc=roc_auc_score(yte,p),acc=accuracy_score(yte,pr),prec=precision_score(yte,pr),rec=recall_score(yte,pr))
res['Référence : tout « à l’heure »']=dict(auc=0.5,acc=1-yte.mean(),prec=float('nan'),rec=0.0)
# taux de retard historique seul
p_hist=Xte.hist_late_rate.values
res['Règle simple : taux de retard passé du client']=dict(auc=roc_auc_score(yte,p_hist),acc=accuracy_score(yte,(p_hist>=0.5)),prec=precision_score(yte,(p_hist>=0.5)),rec=recall_score(yte,(p_hist>=0.5)))
print('test invoices',len(te),'late',yte.mean().round(3))
for k,v in res.items(): print(k,{a:round(b,3) for a,b in v.items()})
coef=pd.Series(lr.coef_[0],index=FEATS).sort_values(); print(coef.round(3))

# --- sensibilité : litige de la facture connu
def with_disp(X,rows): X=X.copy(); X['disp_now']=rows.disp.values; return X
Xtr2=with_disp(Xtr,tr); Xte2=with_disp(Xte,te); sc2=StandardScaler().fit(Xtr2)
lr2=LogisticRegression(max_iter=2000).fit(sc2.transform(Xtr2),ytr)
p2=lr2.predict_proba(sc2.transform(Xte2))[:,1]
res_disp=dict(auc=roc_auc_score(yte,p2),acc=accuracy_score(yte,p2>=0.5))
print('avec litige connu',{a:round(b,3) for a,b in res_disp.items()})

# --- test X vs Z sur instantanés hebdomadaires
snaps=pd.date_range(CUTOFF,'2013-11-25',freq='W-MON')
def snapshot(t, model='lr', mdl=None, scaler=None):
    op=df[(df.InvoiceDate<=t)&(df.SettledDate>=t)&(df.DueDate>=t)&(df.DueDate<t+pd.Timedelta(days=H))].copy()
    if len(op)==0: return op
    op['t']=t
    X=feats(op,'t')
    m=mdl or lr; s=scaler or sc
    op['p']=m.predict_proba(s.transform(X[FEATS]) if s is not None else X[FEATS])[:,1]
    op['risk_amt']=op.p*op.InvoiceAmount
    return op
Ns=[2,3,5,8]
rows=[]; snapdata={}
for t in snaps:
    op=snapshot(t); snapdata[t]=op
    tot=(op.InvoiceAmount*op.late).sum()
    for N in Ns:
        z1=op.sort_values(['DueDate','InvoiceAmount'],ascending=[True,False]).head(N)
        z2=op.sort_values('InvoiceAmount',ascending=False).head(N)
        x=op.sort_values('risk_amt',ascending=False).head(N)
        orc=op.sort_values(['late','InvoiceAmount'],ascending=False).head(N)
        f=lambda s:(s.InvoiceAmount*s.late).sum()
        rows.append(dict(t=t,N=N,n_open=len(op),n_late=op.late.sum(),tot=tot,Z1=f(z1),Z2=f(z2),X=f(x),ORACLE=f(orc),
                         Z1_n=z1.late.sum(),Z2_n=z2.late.sum(),X_n=x.late.sum()))
R=pd.DataFrame(rows)
print('instantanés',len(snaps),'factures à échéance <7j par semaine',R[R.N==3].n_open.mean().round(1),'dont en retard',R[R.N==3].n_late.mean().round(1))
allinv=pd.concat(snapdata.values()); print('factures uniques', allinv.invoiceNumber.nunique(), 'lignes', len(allinv))
summ=R.groupby('N')[['tot','Z1','Z2','X','ORACLE','Z1_n','Z2_n','X_n']].sum()
for c in ['Z1','Z2','X','ORACLE']: summ[c+'_pct']=summ[c]/summ.tot
print(summ.round(3).to_string())
# gagnant semaine par semaine
for N in Ns:
    s=R[R.N==N]; print('N',N,'X>Z1 semaines',(s.X>s.Z1).sum(),'= ',(s.X==s.Z1).sum(),'<',(s.X<s.Z1).sum(),'| X>Z2',(s.X>s.Z2).sum(),'<',(s.X<s.Z2).sum())
# bootstrap IC sur semaines (N=5)
bs=[]
s=R[R.N==3].reset_index(drop=True)
for b in range(2000):
    i=np.random.randint(0,len(s),len(s)); ss=s.iloc[i]
    bs.append((ss.X.sum()-ss.Z1.sum())/ss.tot.sum())
print('Gain X-Z1 N=3 IC95', np.percentile(bs,[2.5,50,97.5]).round(3))
bs2=[]
for b in range(2000):
    i=np.random.randint(0,len(s),len(s)); ss=s.iloc[i]
    bs2.append((ss.X.sum()-ss.Z2.sum())/ss.tot.sum())
print('Gain X-Z2 N=3 IC95', np.percentile(bs2,[2.5,50,97.5]).round(3))

ci={}
for N in Ns:
    s_=R[R.N==N].reset_index(drop=True); a=[];b2=[]
    for b in range(2000):
        i=np.random.randint(0,len(s_),len(s_)); ss=s_.iloc[i]; a.append((ss.X.sum()-ss.Z1.sum())/ss.tot.sum()); b2.append((ss.X.sum()-ss.Z2.sum())/ss.tot.sum())
    ci[N]=dict(z1=np.percentile(a,[2.5,97.5]).tolist(), z2=np.percentile(b2,[2.5,97.5]).tolist())
print('IC', {k:{a:np.round(b,3).tolist() for a,b in v.items()} for k,v in ci.items()})
# --- effet DSO estimé (hypothèse : un contact préventif réduit de moitié le retard des factures contactées qui auraient été en retard)
dso_rows=[]
for N in Ns:
  for meth in ['Z1','Z2','X']:
    saved=0
    for t,op in snapdata.items():
        if meth=='Z1': sel=op.sort_values(['DueDate','InvoiceAmount'],ascending=[True,False]).head(N)
        elif meth=='Z2': sel=op.sort_values('InvoiceAmount',ascending=False).head(N)
        else: sel=op.sort_values('risk_amt',ascending=False).head(N)
        saved+=(sel.InvoiceAmount*sel.DaysLate*0.5).sum()
    dso_rows.append(dict(N=N,meth=meth,saved=saved))
D=pd.DataFrame(dso_rows)
tst=df[(df.DueDate>=CUTOFF)&(df.DueDate<snaps[-1]+pd.Timedelta(days=H))]
base_dso=(tst.DaysToSettle*tst.InvoiceAmount).sum()/tst.InvoiceAmount.sum()
D['dso']=base_dso - D.saved/tst.InvoiceAmount.sum()
print('DSO base', round(base_dso,2)); print(D.round(2).to_string())
# --- boucle d'apprentissage : réentraînement mensuel (fenêtre croissante)
months=pd.date_range(CUTOFF,'2013-11-01',freq='MS')
loop=[]
for m in months:
    trm,Xm,ym=fit(m); scm=StandardScaler().fit(Xm); lrm=LogisticRegression(max_iter=2000).fit(scm.transform(Xm),ym)
    tem=df[(df.InvoiceDate>=m)&(df.InvoiceDate<m+pd.offsets.MonthBegin(1))].copy(); tem['t']=tem.InvoiceDate
    Xtm=feats(tem,'t'); pm=lrm.predict_proba(scm.transform(Xtm))[:,1]
    # modèle figé
    fit(CUTOFF); pf=lr.predict_proba(sc.transform(feats(tem,'t')))[:,1]
    loop.append(dict(mois=m.strftime('%Y-%m'),n_train=len(trm),n=len(tem),auc_recale=roc_auc_score(tem.late,pm),auc_fige=roc_auc_score(tem.late,pf),acc_recale=accuracy_score(tem.late,pm>=.5)))
L=pd.DataFrame(loop); print(L.round(3).to_string())
fit(CUTOFF)

# --- seuils des 3 niveaux : calibration sur test
te['p']=lr.predict_proba(sc.transform(Xte))[:,1]
for lo,hi in [(0,.3),(.3,.6),(.6,1.01)]:
    s=te[(te.p>=lo)&(te.p<hi)]; print(f'p in [{lo},{hi}) n={len(s)} part={len(s)/len(te):.2f} taux retard réel={s.late.mean():.2f} retard moyen={s.DaysLate.mean():.1f}')
# effet DSO estimé : hypothèses
# DSO approx = moyenne pondérée par montant de DaysToSettle
dso=(df[df.InvoiceDate>=CUTOFF].DaysToSettle*df[df.InvoiceDate>=CUTOFF].InvoiceAmount).sum()/df[df.InvoiceDate>=CUTOFF].InvoiceAmount.sum()
print('DSO pondéré test', round(dso,1))
json.dump(dict(ci=ci,dso_base=base_dso,dso_est=D.to_dict('records'),res=res,res_disp=res_disp,summ=summ.reset_index().to_dict('records'),loop=L.to_dict('records'),coef=coef.to_dict(),
  n_train=len(tr),n_test=len(te),late_test=float(yte.mean()),dso=dso,snaps=len(snaps)),open(str(OUT)+'/'+('country_' if WITH_COUNTRY else '')+'results.json','w'),default=str,indent=1)
R.to_csv(str(OUT)+'/'+('country_' if WITH_COUNTRY else '')+'snapshots.csv',index=False)
te[['invoiceNumber','customerID','InvoiceAmount','late','DaysLate','p']].to_csv(str(OUT)+'/'+('country_' if WITH_COUNTRY else '')+'test_scores.csv',index=False)
pd.DataFrame(dict(feat=FEATS,mean=sc.mean_,scale=sc.scale_,coef=lr.coef_[0])).to_csv(str(OUT)+'/'+('country_' if WITH_COUNTRY else '')+'lr_params.csv',index=False)
print('intercept',lr.intercept_)
