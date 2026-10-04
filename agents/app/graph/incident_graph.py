"""
LangGraph wiring — the sequencing, nothing more (plan.md §6).

    triage → investigate → mitigate → END

Compiled with NO checkpointer: the graph never pauses. Human approval happens
in the server between "got a proposal" and "execute it" — ordinary web-app
logic — so there are no thread IDs, no resume, no database saver here.

Nodes are added one agent at a time; the graph below reflects what is built.
"""

from langgraph.graph import END, StateGraph

from app.agents import investigate, mitigate, triage
from app.schemas.state import IncidentState


def build_graph():
    graph = StateGraph(IncidentState)
    graph.add_node("triage", triage.run)
    graph.add_node("investigate", investigate.run)
    graph.add_node("mitigate", mitigate.run)
    graph.set_entry_point("triage")
    graph.add_edge("triage", "investigate")
    graph.add_edge("investigate", "mitigate")
    graph.add_edge("mitigate", END)
    return graph.compile()


app_graph = build_graph()
