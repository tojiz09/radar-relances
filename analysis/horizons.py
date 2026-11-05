import sys, types, pandas as pd, numpy as np
from pathlib import Path
HERE = Path(__file__).resolve().parent
src=open(HERE / 'analysis.py', encoding='utf-8').read()
cut=src.index("# --- test X vs Z sur instantanés hebdomadaires")
ns={'__file__': str(HERE / 'analysis.py')}; sys.argv=['x']; exec(src[:cut], ns)
df=ns['df']; feats=ns['feats']; lr=ns['lr']; sc=ns['sc']; FEATS=ns['FEATS']; CUTOFF=ns['CUTOFF']
snaps=pd.date_range(CUTOFF,'2013-11-25',freq='W-MON')
out=[]
rng=np.random.default_rng(1)
for a,label in [(0,'Échéance dans 0 à 6 jours'),(7,'Échéance dans 7 à 13 jours'),(14,'Échéance dans 14 à 20 jours'),(21,'Échéance dans 21 à 27 jours (facture émise il y a moins de 10 jours)')]:
    rows=[]
    for t in snaps:
        op=df[(df.InvoiceDate<=t)&(df.SettledDate>=t)&(df.DueDate>=t+pd.Timedelta(days=a))&(df.DueDate<t+pd.Timedelta(days=a+7))].copy()
        if len(op)==0: continue
        op['t']=t; X=feats(op,'t'); op['p']=lr.predict_proba(sc.transform(X[FEATS]))[:,1]; op['ra']=op.p*op.InvoiceAmount
        tot=(op.InvoiceAmount*op.late).sum()
        for frac in [0.2,0.3]:
            N=max(1,int(round(frac*len(op))))
            f=lambda s:(s.InvoiceAmount*s.late).sum()
            rows.append(dict(frac=frac,n=len(op),nl=op.late.sum(),tot=tot,
              Z1=f(op.sort_values(['DueDate','InvoiceAmount'],ascending=[True,False]).head(N)),
              Z2=f(op.sort_values('InvoiceAmount',ascending=False).head(N)),
              X=f(op.sort_values('ra',ascending=False).head(N))))
    R=pd.DataFrame(rows)
    for frac in [0.2,0.3]:
        s=R[R.frac==frac].reset_index(drop=True)
        g1=[];g2=[]
        for b in range(2000):
            i=rng.integers(0,len(s),len(s)); ss=s.iloc[i]; g1.append((ss.X.sum()-ss.Z1.sum())/ss.tot.sum()); g2.append((ss.X.sum()-ss.Z2.sum())/ss.tot.sum())
        out.append(dict(fenetre=label,a=a,capacite=f'{int(frac*100)} % des factures',fact_sem=s.n.mean(),taux_retard=s.nl.sum()/s.n.sum(),
            Z1=s.Z1.sum()/s.tot.sum(),Z2=s.Z2.sum()/s.tot.sum(),X=s.X.sum()/s.tot.sum(),
            gZ1=(s.X.sum()-s.Z1.sum())/s.tot.sum(),gZ1_lo=np.percentile(g1,2.5),gZ1_hi=np.percentile(g1,97.5),
            gZ2=(s.X.sum()-s.Z2.sum())/s.tot.sum(),gZ2_lo=np.percentile(g2,2.5),gZ2_hi=np.percentile(g2,97.5)))
O=pd.DataFrame(out); pd.set_option('display.width',250)
print(O.round(3).to_string()); O.to_csv(HERE.parent / 'results' / 'horizons.csv',index=False)
