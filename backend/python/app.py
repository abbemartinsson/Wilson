import streamlit as st
from supabase_chatbot import ask_project_ai

st.set_page_config(page_title="ProjectAI", layout="centered")
st.title("ProjectAI")

if "messages" not in st.session_state:
    st.session_state.messages = [
        {"role": "assistant", "content": "Hej! Fraga mig om projektdata fran Supabase."}
    ]

for message in st.session_state.messages:
    with st.chat_message(message["role"]):
        st.markdown(message["content"])

user_input = st.chat_input("Skriv har...")

if user_input:
    st.session_state.messages.append({"role": "user", "content": user_input})

    with st.chat_message("user"):
        st.markdown(user_input)

    with st.chat_message("assistant"):
        with st.spinner("Tanker..."):
            answer = ask_project_ai(st.session_state.messages)
            st.markdown(answer)

    st.session_state.messages.append({"role": "assistant", "content": answer})
