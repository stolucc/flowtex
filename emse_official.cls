% emse_official.cls
% Wrapper around Springer's svjour3.cls to reproduce the *published front-matter text*
% (NOT guaranteed to reproduce Springer’s exact pagination/line breaks.)
\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{emse_official}[2025/12/24 EMSE wrapper for svjour3]

\LoadClass{svjour3}

\RequirePackage{etoolbox}
\RequirePackage{url}

% -------------------------
% Metadata fields (set these in your .tex via \EMSE... commands)
% -------------------------
\newcommand\EMSE@received{}
\newcommand\EMSE@accepted{}
\newcommand\EMSE@copyright{%
  \textcopyright\ The Author(s), under exclusive licence to Springer Science+Business Media, LLC, part of Springer Nature 2025%
}
\newcommand\EMSE@communicatedby{}
\newcommand\EMSE@extendedauthorinfo{Extended author information available on the last page of the article}
\newcommand\EMSE@journalline{Empirical Software Engineering (2026) 31:40}
\newcommand\EMSE@doiline{https://doi.org/10.1007/s10664-025-10765-4}

\newcommand{\EMSEreceived}[1]{\gdef\EMSE@received{#1}}
\newcommand{\EMSEaccepted}[1]{\gdef\EMSE@accepted{#1}}
\newcommand{\EMSEcopyright}[1]{\gdef\EMSE@copyright{#1}}
\newcommand{\EMSEcommunicatedby}[1]{\gdef\EMSE@communicatedby{#1}}
\newcommand{\EMSEextendedauthorinfo}[1]{\gdef\EMSE@extendedauthorinfo{#1}}
\newcommand{\EMSEjournalline}[1]{\gdef\EMSE@journalline{#1}}
\newcommand{\EMSEdoi}[1]{\gdef\EMSE@doiline{#1}}

% -------------------------
% Title style: match the published PDF's sentence case title
% (svjour3 often leaves case to author; we do NOT auto-titlecase.)
% -------------------------

% -------------------------
% Patch \maketitle to prepend Springer-like production metadata lines
% -------------------------
\makeatletter

% A compact block printed above the title (matches the published PDF text-wise)
\newcommand{\EMSE@frontmatterblock}{%
  \begingroup
  \small
  \noindent
  \ifstrempty{\EMSE@received}{}{Received: \EMSE@received\par}%
  \ifstrempty{\EMSE@accepted}{}{Accepted: \EMSE@accepted\par}%
  \noindent \EMSE@copyright\par
  \ifstrempty{\EMSE@communicatedby}{}{Communicated by: \EMSE@communicatedby.\par}%
  \noindent \EMSE@extendedauthorinfo\par
  \par\medskip
  \endgroup
}

% DOI + journal line (placed under author block in the published PDF;
% here we place it immediately after \maketitle to keep it robust)
\newcommand{\EMSE@doiblock}{%
  \begingroup
  \small
  \noindent \EMSE@journalline\par
  \noindent \url{\EMSE@doiline}\par
  \par\medskip
  \endgroup
}

% Insert the front matter block before the normal title
\pretocmd{\maketitle}{\EMSE@frontmatterblock}{}{}

% Insert DOI/journal line right after title (you can move if needed)
\apptocmd{\maketitle}{\EMSE@doiblock}{}{}

\makeatother

% -------------------------
% Optional: running header text similar to the Springer PDF
% Note: exact "40 Page X of 56" footer/header is production-specific;
% this provides a simple journal header line.
% -------------------------
\makeatletter
\def\ps@headings{%
  \let\@oddfoot\@empty
  \let\@evenfoot\@empty
  \def\@oddhead{\hfil\small\EMSE@journalline\hfil}%
  \def\@evenhead{\@oddhead}%
  \let\@mkboth\@gobbletwo
}
\pagestyle{headings}
\makeatother
